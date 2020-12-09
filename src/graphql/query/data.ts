import { ApolloError, UserInputError } from 'apollo-server';
import { Channels, Videos } from '../../../database';
import { PlatformId } from '../../../database/types/members';
import { memcache } from '../../modules';
import { ChannelId } from '../../modules/types/youtube';
import { cutChannelIds, cutGroupString, getCacheKey, parseOrganization } from './consts';

const CACHE_TTL = +(process.env.TTL_LONG ?? 900);

interface Query {
  organizations: string[];
  exclude_organizations: string[];
  channel_id: ChannelId[];
  platforms: PlatformId[];
}

export async function data(_, query: Query) {
  try {
    const {
      organizations = [],
      exclude_organizations = [],
      channel_id = [],
      platforms = []
    } = query;
    if (organizations.length && exclude_organizations.length) {
      return new UserInputError('Setting both organizations and exclude_organizations is redundant. Only choose one.');
    }
    const EXCLUDE_ORG = !organizations.length;
    const ORGANIZATIONS = parseOrganization(EXCLUDE_ORG ? exclude_organizations : organizations);
    const CACHE_KEY = getCacheKey(`CHNLS:${+EXCLUDE_ORG}${cutGroupString(ORGANIZATIONS)}${cutChannelIds(channel_id)}${platforms}`, false);

    const cached = await memcache.get(CACHE_KEY);
    if (cached) return cached;

    const QUERY = {
      ...ORGANIZATIONS[0] && { organization: {
        ...EXCLUDE_ORG
          ? { $not: { $regex: ORGANIZATIONS, $options: 'i' } }
          : { $regex: ORGANIZATIONS, $options: 'i' }
      } },
      ...channel_id[0] && { channel_id: { $in: channel_id } },
      ...platforms[0] && { platform_id: { $in: platforms } }
    };

    const getChannelList = Channels.find(QUERY).lean().exec();
    const getVideoCount = Videos.countDocuments(QUERY).lean().exec();
    const [channelList, videoCount] = await Promise.all([getChannelList, getVideoCount]);
    const groupList = channelList
      .map(value => value.organization)
      .filter((value, index, array) => array.indexOf(value) === index);
    const channelCount = channelList.length;

    const result = {
      organizations: groupList,
      channels: channelCount,
      videos: videoCount
    };

    memcache.set(CACHE_KEY, result, CACHE_TTL);
    return result;
  } catch(err) {
    throw new ApolloError(err);
  }
}
