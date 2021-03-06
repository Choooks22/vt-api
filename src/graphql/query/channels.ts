import { ApolloError, UserInputError } from 'apollo-server';
import { PlatformId } from '../../../database/types/members';
import { Channels, memcache } from '../../modules';
import { ChannelId } from '../../modules/types/youtube';
import { cutChannelIds, cutGroupString, escapeRegex, firstField, getCacheKey, getNextToken, parseOrganization, parseToken, Sort } from './consts';

const CACHE_TTL = +(process.env.TTL_LONG ?? 900);

interface OrderBy {
  _id?: Sort;
  published_at?: Sort;
  subscribers?: Sort;
}

interface ChannelsQuery {
  _id: number[];
  name: string;
  organizations: string[];
  exclude_organizations: string[];
  platforms: PlatformId[];
  exclude_channel_id: ChannelId[];
  channel_id: ChannelId[];
  order_by: OrderBy;
  page_token: string;
  limit: number;
}

export async function channels(_, query: ChannelsQuery) {
  try {
    const {
      _id = [],
      name = '',
      organizations = [],
      exclude_organizations = [],
      exclude_channel_id = [],
      channel_id = [],
      platforms = [],
      page_token = '',
      limit
    } = query;
    if (limit < 1 || limit > 50) {
      return new UserInputError('limit must be between 1-50 inclusive.');
    }
    if (organizations.length && exclude_organizations.length) {
      return new UserInputError('Setting both organizations and exclude_organizations is redundant. Only choose one.');
    }
    if (channel_id.length && exclude_channel_id.length) {
      return new UserInputError('Setting both channel_id and exclude_channel_id is redundant. Only choose one.');
    }
    const EXCLUDE_ORG = !organizations.length;
    const EXCLUDE_IDS = !channel_id.length;
    const [ORDER_BY, ORDER_BY_KEY] = firstField(query.order_by);
    const [ORDER_KEY, ORDER_VALUE] = Object.entries(ORDER_BY)[0];
    const sortById = ORDER_KEY === '_id';
    const sortBy = sortById ? ORDER_BY : { [`channel_stats.${ORDER_KEY}`]: ORDER_VALUE };
    const ORGANIZATIONS = parseOrganization(EXCLUDE_ORG ? exclude_organizations : organizations);
    const CHANNEL_IDS = EXCLUDE_IDS ? exclude_channel_id : channel_id;
    const CACHE_KEY = getCacheKey(`CHNLS:${+EXCLUDE_ORG}${+EXCLUDE_IDS}${_id}${(name)}${cutGroupString(ORGANIZATIONS)}${cutChannelIds(CHANNEL_IDS)}${platforms}${limit}${ORDER_BY_KEY}${page_token}`, false);

    const cached = await memcache.get(CACHE_KEY);
    if (cached) return cached;

    const QUERY = {
      _id: { [_id[0] ? '$in' : '$nin']: _id },
      ...name && { $or: getNameQueries(name) },
      ...ORGANIZATIONS[0] && { organization: {
        ...EXCLUDE_ORG
          ? { $not: { $regex: ORGANIZATIONS, $options: 'i' } }
          : { $regex: ORGANIZATIONS, $options: 'i' }
      } },
      ...channel_id[0] && { channel_id: { [EXCLUDE_IDS ? '$nin' : '$in']: CHANNEL_IDS } },
      ...platforms[0] && { platform_id: { $in: platforms } }
    };

    const getChannelCount = Channels.countDocuments(QUERY);
    const getUncachedChannels = Channels
      .find({
        ...QUERY,
        ...page_token && { [Object.keys(sortBy)[0]]: { [ORDER_VALUE === 'asc' ? '$gte' : '$lte']: parseToken(page_token) } },
      })
      .sort(sortBy)
      .limit(limit + 1)
      .lean()
      .exec();

    const [channelCount, uncachedChannels] = await Promise.all([getChannelCount, getUncachedChannels]);
    const results = {
      items: uncachedChannels,
      next_page_token: null,
      page_info: {
        total_results: channelCount,
        results_per_page: limit
      }
    };

    const hasNextPage = uncachedChannels.length > limit && results.items.pop();
    if (hasNextPage) {
      const token = sortById ? hasNextPage._id : hasNextPage.channel_stats[ORDER_KEY];
      results.next_page_token = getNextToken(token);
    }

    memcache.set(CACHE_KEY, results, CACHE_TTL);
    return results;
  } catch(err) {
    throw new ApolloError(err);
  }
}

const getNameQueries = (name: string) => {
  const nameRegex = escapeRegex(unescape(name)).split(/ +/g).map(string => `(?=.*${string})`).join('');
  return [
    { 'name.en': { $regex: nameRegex, $options: 'i' } },
    { 'name.jp': { $regex: nameRegex, $options: 'i' } },
    { 'name.kr': { $regex: nameRegex, $options: 'i' } },
    { 'name.cn': { $regex: nameRegex, $options: 'i' } }
  ];
};
