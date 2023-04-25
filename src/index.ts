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

/** Max number of errors before it gives up. There's no reset. I just dont want to keep hitting the server if somethings wrong. */
const MAX_ERRORS = 5;
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
const LIKE_MIN = 4;
/** Max likes to be considered */
const LIKE_MAX = 7;
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
	let params: { limit: number; cursor?: string } = { limit: GET_POST_LIMIT_LIMIT };
	if (lastCursor) {
		params = { ...params, cursor: lastCursor };
	}
	const { data } = await agent.getTimeline(params);
	let posts = data.feed;
	let cursor = data.cursor;

	let rootLevel = posts.filter((post) => !post.reply && !post.reason);	
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

	// If last post is too old, return
	if (!postIsRecent(posts[posts.length - 1])) {
		return;
	}

	await checkPosts(cursor);
};


let errorCount = 0;
const run = async () => {
	console.log('Running...');
	try {
		await followBack();
		writeFollowing();
		await checkPosts();
		writeReposted();
		setTimeout(run, DELAY_MILISECONDS);
	} catch (e) {
		console.log('Failed with error: ');
		console.log(e);
		errorCount++;
		if (errorCount > MAX_ERRORS) {
			console.log('It\'s gone to shit. Exiting.');
			process.exit(1);
		}
		
	}
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
