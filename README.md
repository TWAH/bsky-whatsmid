# @whatsmid.bsky.social bot

## WARNING ⚠️

I wouldn't trust this code as far as I can throw it. Code might be trash, it might be bullet proof, use it at your own risk etc.

---

## System requirements
- Node
- ts-node installed globally: `npm install -g ts-node` (I'd actually advise compiling to js and running with pm2 but this works for testing)

## Setup
- Create a .env file in the root of the project.  Provide the following:
```
BSKY_IDENTIFIER="YOUR BSKY BOT EMAIL"
BSKY_PASSWORD="YOUR BSKY BOT PASSWORD - USE AN APP PASSWORD"
```
- Optional: Change `const`s in `src/index.ts` to your liking
- Optional: Change the language preference in `postIsEnglish`. The check is done with the [languagedetect](https://github.com/FGRibreau/node-language-detect) package. See docs for your options.
- Run `npm install`

## To run


`ts-node src/index.ts`

## To do

- [X] Unfollow people who unfollow us
- [ ] Minimise api requests.
- [ ] The rest of the owl 🦉