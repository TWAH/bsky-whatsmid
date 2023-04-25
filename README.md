# @whatsmid.bsky.social bot

## WARNING ⚠️

"I wouldn't trust this code as far as I can throw it. If it was hosted on a server, I'd be able to throw it pretty far, but I still wouldn't trust it." - Copilot

Idk, Copilot, are we talking about a 1u server or the whole rack?

Anyway, code might be trash, it might be bullet proof, use it at your own risk etc.

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

- [ ] Unfollow people who unfollow us :( (don't tell anyone this doesn't work yet)
- [ ] The rest of the owl 🦉