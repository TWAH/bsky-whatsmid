import * as dotenv from 'dotenv';
dotenv.config();

import { BskyAgent } from '@atproto/api';
import { readFileSync, writeFileSync } from 'fs';
import { QueryParams as GetFollowParams } from '@atproto/api/dist/client/types/app/bsky/graph/getFollowers';
import { FeedViewPost } from '@atproto/api/dist/client/types/app/bsky/feed/defs';
import LanguageDetect from 'languagedetect';

const lngDetector = new LanguageDetect();

const agent = new BskyAgent({
	service: 'https://bsky.social',
});

//#region Setup

/** Delay between each run. The timer starts from the end of the last run. */
const DELAY_SECONDS = 30;
const DELAY_MILISECONDS = DELAY_SECONDS * 1000;
/**
 * Where the following & resposted ids are stored.
 * Used to avoid spamming the server & ghost notifications
 */
const STORE_DIR = `${process.cwd()}/store`;

/** Max number of *type* to get. Limit is 100. */
const GET_FOLLOWING_LIMIT = 100;
const GET_FOLLOWER_LIMIT = 100;
const GET_POST_LIMIT_LIMIT = 100;

/** Max age of a post to be considered */
const MAX_AGE_HOURS = 2;
const MAX_AGE = 1000 * 60 * (60 * MAX_AGE_HOURS);
/** Min age of a post to be considered - to avoid reposting what would could be a hot post */
const MIN_AGE_HOURS = 0.5;
const MIN_AGE = 1000 * 60 * (60 * MIN_AGE_HOURS);

/** Min likes to be considered */
const LIKE_MIN = 6;
/** Max likes to be considered */
const LIKE_MAX = 11;
/** Probably not necessary */
const LIKE_WEIGHT = 1;
/** Allows for giving more weight to a repost */
const REPOST_WEIGHT = 2;
//#endregion

let following: string[] = [];
let repostedCids: string[] = [];

const readFollowing = () => {
	try {
		const followingStr = readFileSync(`${STORE_DIR}/following.json`, 'utf-8');
		const followingJson = JSON.parse(followingStr);
		following = followingJson;
	} catch (e) {
		following = [];
	}
};
const readReposted = () => {
	try {
		const repostedStr = readFileSync(`${STORE_DIR}/reposted.json`, 'utf-8');
		const repostedJson = JSON.parse(repostedStr);
		repostedCids = repostedJson;
	} catch (e) {
		repostedCids = [];
	}
};

const writeFollowing = () => {
	writeFileSync(`${STORE_DIR}/following.json`, JSON.stringify(following));
};
const writeReposted = () => {
	writeFileSync(`${STORE_DIR}/reposted.json`, JSON.stringify(repostedCids));
};

const getFollowing = async (lastCursor?: string) => {
	let params: GetFollowParams = { actor: agent.session?.did || '', limit: GET_FOLLOWING_LIMIT };
	if (lastCursor) {
		params = { ...params, cursor: lastCursor };
	}
	const {
		data: { follows, cursor },
	} = await agent.getFollows(params);
	const followingIds = follows.map((f) => f.did);
	const distinct = followingIds.filter((f) => !following.includes(f));
	following.push(...distinct);

	if (follows.length % GET_FOLLOWING_LIMIT !== 0) {
		return;
	}

	getFollowing(cursor);
};

let lastSeenDid: string | undefined;
const followBack = async (lastCursor?: string) => {
	console.log('Running followBack...');
	let params: GetFollowParams = { actor: agent.session?.did || '', limit: GET_FOLLOWER_LIMIT };
	if (lastCursor) {
		params = { ...params, cursor: lastCursor };
	}
	let {
		data: { cursor, followers },
	} = await agent.getFollowers(params);

	// Ignore before since the lastSeenDid
	if (lastSeenDid) {
		const lastSeenIndex = followers.findIndex((f) => f.did === lastSeenDid);
		if (lastSeenIndex === 0) {
			//if lastSeenDid is the first in the list, we're done
			return;
		}
		if (lastSeenIndex !== -1) {
			followers = followers.slice(0, lastSeenIndex);
		}
	}

	// If we already follow them, return. This can happen if the lastSeenDid has unfollowed or the service has just started
	followers = followers.filter((f) => !following.includes(f.did));

	if (followers.length === 0) {
		return;
	}

	let followOps: Promise<any>[] = [];
	for (let i = 0; i < followers.length; i++) {
		const f = followers[i];
		console.log('FOLLOWING... ', f.handle);
		followOps.push(agent.follow(f.did));
		following.push(f.did);
	}

	await Promise.all(followOps);

	//update lastSeenDid if lastCursor is not set - cursor not set = first page & therefore most recent
	if (!lastCursor) {
		lastSeenDid = followers[0].did;
	}

	// If result is not a multiple of limit, we're done
	// This will also be the case if lastSeenIndex is -1 but all the other accounts are already followed. This is happy accident because it would loop through all followers again if not.
	if (followers.length % GET_FOLLOWER_LIMIT !== 0) {
		return;
	}

	await followBack(cursor);
};

const postIsEnglish = (post: FeedViewPost): boolean => {
	const { text } = post.post.record as { text: string; createdAt: string };
	if (text.length === 0) {
		return false;
	}
	const lng = lngDetector.detect(text, 1);

	return !!lng.length && (lng[0][0] === 'english' || lng[0][0] === 'pidgin');
};

const postIsRecent = (post: FeedViewPost): boolean => {
	const now = new Date();
	const { createdAt: createdAtStr } = post.post.record as { text: string; createdAt: string };
	const createdAt = new Date(createdAtStr);
	const age = now.getTime() - createdAt.getTime();
	return age < MAX_AGE && age > MIN_AGE;
};

const postIsTooOld = (post: FeedViewPost): boolean => {
	const now = new Date();
	const { createdAt: createdAtStr } = post.post.record as { text: string; createdAt: string };
	const createdAt = new Date(createdAtStr);
	const age = now.getTime() - createdAt.getTime();
	return age > MAX_AGE;
}

const postMeetsCriteria = (post: FeedViewPost): boolean => {
	const likeCount = post.post.likeCount ?? 0;
	const repostCount = post.post.repostCount ?? 0;
	const postWeight = likeCount * LIKE_WEIGHT + repostCount * REPOST_WEIGHT;

	const isEnglish = postIsEnglish(post);
	const isRecent = postIsRecent(post);

	if (!isEnglish) {
		return false;
	}
	if (!isRecent) {
		return false;
	}
	if (likeCount > LIKE_MAX) {
		return false;
	}
	if (postWeight >= LIKE_MIN) {
		return true;
	}
	return false;
};

const checkPosts = async (lastCursor?: string) => {
	console.log('Running checkPosts...');
	let params: { limit: number; cursor?: string } = { limit: GET_POST_LIMIT_LIMIT };
	if (lastCursor) {
		params = { ...params, cursor: lastCursor };
	}
	const { data } = await agent.getTimeline(params);
	let posts = data.feed;
	let cursor = data.cursor;

	let rootLevel = posts.filter((post) => !(post.post.record as any).reply && !post.reason && !post.reply);
	rootLevel = rootLevel.filter((post) => !repostedCids.includes(post.post.cid));
	let midPosts = rootLevel.filter(postMeetsCriteria);
	let repostOps: Promise<any>[] = [];
	for (let i = 0; i < midPosts.length; i++) {
		const post = midPosts[i];
		console.log('REPOSTING... ', post.post.cid);
		const repost = agent.repost(post.post.uri, post.post.cid);
		repostedCids.push(post.post.cid);
		repostOps.push(repost);
	}
	await Promise.all(repostOps);

	// If there are no posts for whatever reason, return
	if (posts.length === 0) {
		return;
	}
	// If last post is too old, return
	if (rootLevel.length > 0 && postIsTooOld(rootLevel[rootLevel.length - 1])) {
		return;
	}

	await checkPosts(cursor);
};

// Used intermittently to check if we've been unfollowed
const getAllFollowers = async (lastCursor?: string): Promise<string[]> => {
	let result: string[] = [];
	let params: GetFollowParams = { actor: agent.session?.did || '', limit: GET_FOLLOWER_LIMIT };
	if (lastCursor) {
		params = { ...params, cursor: lastCursor };
	}
	let {
		data: { cursor, followers },
	} = await agent.getFollowers(params);
	const followerCids = followers.map((f) => f.did);

	result.push(...followerCids);
	if (cursor) {
		const nextPage = await getAllFollowers(cursor);
		result.push(...nextPage);
	}
	return result;
};

// Used intermittently to check if we've been unfollowed
const getAllFollowing = async (lastCursor?: string): Promise<{did: string, uri: string}[]> => {
	let result: {did: string, uri: string}[] = [];
	let params: GetFollowParams = { actor: agent.session?.did || '', limit: GET_FOLLOWING_LIMIT };
	if (lastCursor) {
		params = { ...params, cursor: lastCursor };
	}
	let {
		data: { cursor, follows },
	} = await agent.getFollows(params);
	const followerCids = follows.map((f) => ({did: f.did, uri: f.viewer?.following ?? ''}));

	result.push(...followerCids);
	if (cursor) {
		const nextPage = await getAllFollowing(cursor);
		result.push(...nextPage);
	}
	return result;
};

const unfollow = async () => {
	console.log('Running unfollow...');
	const followers = await getAllFollowers();
	const allFollowing = await getAllFollowing();
	const unfollowed = allFollowing.filter((f) => !followers.includes(f.did));

	let unfollowOps: Promise<any>[] = [];
	for (let i = 0; i < unfollowed.length; i++) {
		const user = unfollowed[i];
		console.log('UNFOLLOWING... ', user.uri);
		const unfollow = agent.deleteFollow(user.uri);
		unfollowOps.push(unfollow);
	}

	await Promise.all(unfollowOps);

	console.log('UNFOLLOWED: ', unfollowed.length);
	following = allFollowing.filter((f) => !unfollowed.map((uf) => uf.did).includes(f.did)).map(f => f.did);
	console.log('FOLLOWING: ', following.length);
	writeFollowing();
};

let runCount = 0;
const run = async () => {
	runCount++;
	console.log('=====================');
	console.log('Running...');
	await followBack();
	writeFollowing();
	await checkPosts();
	writeReposted();
	//Only check for unfollows every 5 runs
	if (runCount % 5 === 0) {
		await unfollow();
	}
	console.log('=====================');
	setTimeout(run, DELAY_MILISECONDS);
};

const init = async () => {
	await agent.login({
		identifier: process.env.BSKY_IDENTIFIER!,
		password: process.env.BSKY_PASSWORD!,
	});
	readReposted();
	readFollowing();
	if (following.length) {
		//Assume the service hasn't run without writing to the store
		return;
	}
	await getFollowing();
};

(async () => {
	await init();
	await run();
})();
