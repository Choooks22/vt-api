import fetch from 'node-fetch';
import schedule from 'node-schedule';
import { parseStringPromise } from 'xml2js';
import { Channels, debug, memcache } from '../../../modules';
import { ChannelId } from '../../../modules/types/youtube';
import database from '../../database-managers/youtube';
import { VideoXmlEntry, YoutubeVideoObject } from './types';

const logger = debug('api:youtube:xml-crawler');
const CACHE_TTL = +process.env.TTL_LONG || 900;

export default init;
export async function init(timer = '1 * * * * *') {
  const channelList = await Channels.find({ platform_id: 'yt' });
  channelList.forEach(channel => {
    const { channel_id, organization } = channel;
    const xmlScraper = new XmlScraper(channel_id, organization);
    schedule.scheduleJob(`xml-crawler:${channel_id}`, timer, crawler.bind(xmlScraper));
  });
  logger.info(`Now scraping ${channelList.length} youtube channel xmls.`);
}

class XmlScraper {
  private rawXmlData = null;
  private xmlOptions = { explicitArray: false };
  constructor(private channel_id: ChannelId, private organization: string) {}
  private get xmlLink() { return `https://www.youtube.com/feeds/videos.xml?channel_id=${this.channel_id}&t=${Date.now()}`; }
  get channelId() { return this.channel_id; }
  get cacheId() { return `yt-${this.channel_id}`; }
  async fetchXml(): Promise<YoutubeVideoObject[]> {
    this.rawXmlData = await fetch(this.xmlLink).then(res => res.text());
    return this.parseXml();
  }
  private async parseXml(): Promise<YoutubeVideoObject[]> {
    const parsedString = await parseStringPromise(this.rawXmlData, this.xmlOptions)
      .catch(() => logger.warn(`Channel ${this.channelId} doesn\'t exist.`));
    if (!parsedString || !parsedString.feed.entry?.map) return;
    return parsedString.feed.entry.map(this.parseEntries.bind(this)).sort(this.videoSorter);
  }
  private videoSorter(video1: YoutubeVideoObject, video2: YoutubeVideoObject) {
    return +video2.crawled_at - +video1.crawled_at;
  }
  private parseEntries(entry: VideoXmlEntry): YoutubeVideoObject {
    return {
      _id: entry['yt:videoId'],
      platform_id: 'yt',
      channel_id: entry['yt:channelId'],
      organization: this.organization,
      title: entry.title,
      status: 'new',
      crawled_at: new Date(entry.published)
    };
  }
}

async function crawler(this: XmlScraper) {
  logger.log(`Crawling ${this.channelId}...`);
  const latestTimestamp = (await memcache.get(this.cacheId)) ?? 0;
  const videoList = await this.fetchXml();
  if (!videoList) return logger.warn(`${this.channelId} didn\'t return anything?`);
  const newVideos = videoList.filter(video => video.crawled_at > latestTimestamp);
  if (!newVideos.length) return logger.log(`${this.channelId} doesn\'t have new videos.`);
  logger.info(`Found ${newVideos.length} new videos from ${this.channelId}`);
  memcache.set(this.cacheId, newVideos[0].crawled_at, CACHE_TTL);
  database.emit('save-videos', newVideos);
}
