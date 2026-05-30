# Brand Copy Agent — User Personas

Stress-test personas for the Lattice brand copywriting agent. Each persona is designed to expose a different failure mode in a multi-channel copy pipeline.

---

## Persona 1: Maya Chen — The "Typical" User

**Role:** Marketing Lead at a Series A crypto startup
**Context:** Manages Twitter, paid ads, and landing page updates. Has a brand guide but it's a living Google Doc nobody agrees on. Reports to a CEO who rewrites her copy in Slack DMs.

```ts
const maya: Persona = {
  identity: {
    name: 'Maya Chen',
    role: 'Head of Marketing, Series A DeFi protocol',
    context: 'Solo marketer. No copywriter on staff. Ships tweets herself, briefs freelancers for landing pages. CEO reviews everything and makes vague edit requests like "make it punchier."'
  },
  constraints: [
    'Cannot use the word "revolutionary" or "disrupt" — CEO banned them after a cringe tweet',
    'Must include a CTA in every tweet thread',
    'Landing page copy must be under 150 words per section — no exceptions',
    'Cannot mention competitor names directly (legal said no)',
  ],
  messyTruths: [
    'Her "brand guide" has three conflicting tone descriptions because the CEO, CTO, and founding designer each wrote their own section and never reconciled',
    'She doesn\'t know the difference between her protocol\'s value prop and her competitor\'s — she copies positioning from competitor tweets and tweaks the wording',
    'She measures success by engagement metrics but the CEO measures by inbound developer signups, and they almost never correlate',
    'She has never talked to an actual developer who uses the product',
  ],
  badData: {
    targetAudience: 'crypto Twitter degens',
    brandVoice: 'witty and irreverent, like Wendy\'s',
    competitors: 'Alchemy and QuickNode are basically the same thing',
    tonePreference: 'professional with memes',
    channelStrategy: 'Twitter is the only channel that matters',
  },
  mustAsk: [
    'What is the specific feature or announcement this copy is for?',
    'Who is the actual decision-maker reading this — a developer, a founder, or a VC?',
    'What does the reader need to DO after reading this?',
    'Is this for an existing audience or cold acquisition?',
  ],
  integrationIntents: [
    { id: 'twitter-thread', purpose: 'Generate a 5-8 tweet thread for a product launch' },
    { id: 'ad-copy-variants', purpose: 'A/B test ad copy for paid Twitter/LinkedIn campaigns' },
    { id: 'landing-section', purpose: 'Rewrite the hero section of the marketing site' },
  ],
  activationArtifact: 'A ready-to-post tweet thread, two ad variants, and a landing page hero rewrite — all in consistent brand voice, delivered in one session',
}
```

### Conversation Script (Maya)

**Turn 1 — Maya:** "i need a launch thread for our new indexing feature. we're announcing next tuesday. should be hype but not cringe."

**Agent:** "Got it. Before I draft — what does 'indexing feature' mean for the person reading this? Is it faster queries, a new API, self-serve setup? I need the one-line benefit, not the feature name."

**Turn 2 — Maya:** "it's basically we're making it so devs don't have to write their own subgraphs anymore. they just point at a contract and we handle it. CEO wants to call it 'one-click indexing' but i think that sounds like a wordpress plugin."

**Agent:** "'One-click indexing' does flatten it. I'll avoid that. One more thing — is this thread for developers who already know what subgraphs are, or for a broader audience that needs the problem explained first? The opener changes entirely."

**Turn 3 — Maya:** "devs who know. they're the ones signing up. don't explain what a subgraph is, they'll roll their eyes."

**Agent:** *[delivers thread + two ad variants + hero line]* "Here's the thread — leads with the pain, not the feature. Two ad variants: one for Twitter (shorter, attitude), one for LinkedIn (slightly more context, same voice). Hero line for the landing page to match. The voice is direct, no hype words, short sentences. Let me know if the CEO's 'punchier' note means cutting words or adding edge — those are different things."

**Turn 4 — Maya:** "the CEO says 'more energy.' i don't know what that means either. can you just make it… louder? without being embarrassing?"

**Agent:** "Loud without cringe means sharper opinions, not more exclamation points. I'll tighten the openers to be more confrontational about the problem and trim hedging language. If he still says 'more energy' after this, ask him to point to a specific tweet he likes — that'll tell us more than his feedback does."

---

## Persona 2: Rashid Patel — The Stressed Founder Under Time Pressure

**Role:** CEO/Co-founder, pre-seed on-chain analytics startup
**Context:** Launching at a hackathon in 6 hours. Has a product but no marketing materials. Needs everything right now.

```ts
const rashid: Persona = {
  identity: {
    name: 'Rashid Patel',
    role: 'Co-founder & CEO, pre-seed on-chain analytics startup',
    context: 'Technical founder who built the product himself. Launching a public beta at ETH Denver hackathon demo day. Has a Twitter account with 200 followers. No marketing hire. Has never written marketing copy intentionally. Running on 4 hours of sleep.',
  },
  constraints: [
    'Must not use language that implies the product is live in production — it\'s a beta',
    'Cannot make specific performance claims (hasn\'t benchmarked yet)',
    'Has exactly $0 marketing budget — organic only',
    'Cannot spend more than 15 minutes on this — literally has to prep a demo too',
  ],
  messyTruths: [
    'He doesn\'t actually know what his product\'s core differentiator is — he built what he wished existed and never articulated the "why" beyond "the existing stuff sucks"',
    'His "brand" is whatever he\'s tweeted in the past, which is a mix of shitposting, technical threads, and complaining about RPC providers — there is no consistent voice',
    'He\'s simultaneously embarrassed by marketing-speak and jealous of competitors whose marketing looks polished',
    'The demo he\'s about to give might not work on the hotel WiFi, so the tweet thread IS the backup plan',
  ],
  badData: {
    targetAudience: 'everyone at the hackathon',
    productStage: 'we\'re basically ready to launch',
    competitiveAdvantage: 'we\'re faster than everyone else',
    timeline: 'no rush, just need it before the demo',
    existingBrand: 'i don\'t really have a brand yet, just make it sound cool',
  },
  mustAsk: [
    'What does your product actually do in one sentence a tired developer would understand?',
    'What\'s the ONE thing you want someone to do after seeing this — follow you, try the beta, remember your name?',
    'Are there any claims you\'re not comfortable making yet (speed, reliability, etc.)?',
    'What\'s your product called and is there a URL?',
  ],
  integrationIntents: [
    { id: 'launch-thread', purpose: 'Announce the beta launch — the only marketing asset for the demo day' },
    { id: 'bio-update', purpose: 'Rewrite his Twitter bio to not say "building in web3 🚀"' },
    { id: 'one-liner', purpose: 'A single line for the hackathon slide deck' },
  ],
  activationArtifact: 'A launch tweet thread, updated Twitter bio, and one slide-deck line — all shippable in under 10 minutes with zero revision rounds',
}
```

### Conversation Script (Rashid)

**Turn 1 — Rashid:** "hey i need launch copy. we\'re launching at eth denver. on-chain data tool. make it sound good."

**Agent:** "I need three things fast: 1) What does it do in one sentence — not 'on-chain data tool,' what does the developer type and what comes back? 2) What should they do after reading — try a demo, follow you, join a waitlist? 3) What's it called and is there a link?"

**Turn 2 — Rashid:** "it\'s called meridian. you give it a contract address, it indexes the events and gives you a queryable API. they should go to meridian.dev and try it. it\'s a beta tho so don\'t say it\'s production ready."

**Agent:** "Got it. Last thing — you said 'make it sound good.' I can go two directions: confident and direct (tells devs exactly what it does, no fluff) or personality-forward (leads with an opinion about the current state of tooling). Which one matches how you actually talk?"

**Turn 3 — Rashid:** "uhhh the first one i guess. i hate marketing bullshit. just tell them what it is."

**Agent:** *[delivers thread + bio + slide line]* "Thread: 6 tweets, leads with the problem, shows the fix, ends with the link. No hype words, no emojis except one at the CTA. Bio is one line, no 🚀. Slide line is 8 words. You can ship all three as-is. If the demo WiFi dies, the thread still works — pin it before you go on stage."

**Turn 4 — Rashid:** "this is good. can you also do a version that\'s more… like, aggressive? like calling out the current tools. my co-founder thinks we should go harder."

**Agent:** "Here's a version with a sharper opener — names the problem more bluntly. I didn't name competitors (you don't need that smoke at a launch). If your co-founder wants 'aggressive,' this is the line — attacking tooling, not people. Don't let him talk you into a Hot Take opener. You're the new kid. Let the product be loud."

---

## Persona 3: Dr. Lena Vasquez — The Technical Founder Who Hates Marketing

**Role:** CTO/Co-founder, early-stage infrastructure protocol
**Context:** Former distributed systems PhD. Views marketing as necessary evil. Will reject anything that sounds like it was written by a marketer.

```ts
const lena: Persona = {
  identity: {
    name: 'Dr. Lena Vasquez',
    role: 'CTO & Co-founder, early-stage RPC infrastructure protocol',
    context: 'Built a technically superior product. Has strong opinions about everything. Her GitHub README is better-written than her marketing site. Speaks in precise, technical language and gets annoyed when copy oversimplifies or misrepresents the tech. Would rather ship code than review tweets. Has 3,000 Twitter followers from technical threads she wrote herself.',
  },
  constraints: [
    'Will not approve copy that uses superlatives ("fastest," "best," "simplest") without proof',
    'Cannot misrepresent how the tech works — even slightly — for marketing purposes',
    'Refuses to use the word "seamless" or "effortless" — "nothing in infrastructure is effortless"',
    'Must acknowledge tradeoffs, not just benefits — she considers dishonest marketing unethical',
    'Will not target non-technical audiences — "we don\'t need tourists"',
  ],
  messyTruths: [
    'Her precision makes copy technically accurate but nobody outside her niche can understand it — and she doesn\'t realize this is a problem',
    'She says she hates marketing but retweets well-written technical marketing from companies she respects — she hates BAD marketing, not all marketing',
    'Her "just be technical" preference actually means "write like I write," but she can\'t articulate her own writing patterns',
    'She needs developer adoption but her copy speaks to people who already agree with her, not people who need convincing',
  ],
  badData: {
    audienceLevel: 'they should already understand RPC infrastructure',
    brandVoice: 'just be accurate, i don\'t care about voice',
    competitiveLandscape: 'we don\'t have competitors, what we do is different',
    channelPriority: 'just the docs and maybe twitter, i don\'t need ads',
    successMetric: 'if the tech is good, people will use it',
  },
  mustAsk: [
    'What is the specific technical claim this copy needs to communicate?',
    'What tradeoff or limitation should I acknowledge, and how honest do you want me to be about it?',
    'Can you point to one piece of marketing from another company that you think does this right?',
    'Who is the reader who disagrees with you or doesn\'t yet care — and what do they need to hear?',
  ],
  integrationIntents: [
    { id: 'technical-thread', purpose: 'A Twitter thread explaining a new capability — must be accurate enough for peer review' },
    { id: 'docs-intro', purpose: 'Rewrite the landing page intro to not sound like every other infra company' },
    { id: 'pitch-line', purpose: 'A 10-word description for conference badges and DMs' },
  ],
  activationArtifact: 'Copy that passes her technical accuracy check on first read. If she finds a misleading simplification, she\'ll reject the entire output and write it herself.',
}
```

### Conversation Script (Lena)

**Turn 1 — Lena:** "I need copy for our new streaming API. The marketing site says 'real-time data' but that\'s not technically accurate — it\'s websocket-based streaming with configurable buffer windows. I don\'t want to lie but I also don\'t want to write a spec sheet."

**Agent:** "Understood. The phrase 'real-time data' is doing work you don't want it to do. Two questions: 1) What's the honest latency range your users actually see — even a ballpark? 'Streaming with sub-second delivery' is more specific than 'real-time' and still marketable. 2) What's the tradeoff — does the buffer window mean there's a configurability tax, or is it set-and-forget?"

**Turn 2 — Lena:** "latency is usually 50-200ms depending on chain congestion. buffer window is configurable but we ship sensible defaults — most devs won\'t touch it. the tradeoff is that we only stream confirmed blocks, so there\'s a finality delay on some chains."

**Agent:** "That finality-delay point is actually a trust signal worth leading with — it means you're not lying about data certainty. Here's how I'd frame it: 'streams confirmed, not speculative. 50-200ms. you configure nothing.' That gives you specificity without a spec sheet. Want me to draft the full page intro around that framing, or does 'confirmed, not speculative' feel too confrontational toward competitors who stream pending blocks?"

**Turn 3 — Lena:** "no, i like that. it\'s a real difference. just don\'t name anyone. and the thread needs to be technically correct — if you say 'real-time' anywhere i\'ll rewrite the whole thing."

**Agent:** *[delivers thread + intro + pitch line]* "Thread walks through the streaming model — confirmed blocks, configurable windows, actual latency numbers. No 'real-time.' The landing intro leads with the 'confirmed, not speculative' line. Pitch line: 'streaming confirmed on-chain data. no guessing.' I included a footnote-sized caveat about finality delay — it's honest without undermining the pitch. If this isn't technical enough, tell me which sentence fails your accuracy check and I'll fix that sentence, not the whole thing."

**Turn 4 — Lena:** "this is fine. one thing — can you make the landing page version less… salesy? it reads like you\'re trying to convince someone. i want it to read like a fact."

**Agent:** "Pulled the conviction language. Removed the imperative verbs. Now it reads like a description, not a pitch. 'Lattice streams confirmed on-chain data. Configurable buffer, sensible defaults. 50-200ms latency.' That's a fact, not a sell. If someone doesn't care after reading that, they weren't going to care no matter how you wrote it."

---

## Persona 4: Jordan Okafor — The Inconsistent Brand Voice

**Role:** Growth Lead at an L2 chain
**Context:** Manages community, social, and paid channels. The brand voice is whatever the last person to post decided it was.

```ts
const jordan: Persona = {
  identity: {
    name: 'Jordan Okafor',
    role: 'Growth Lead, Layer 2 blockchain',
    context: 'Inherited a brand that was built by three different people across two years. The Twitter voice is casual and memey (community manager\'s style). The blog is formal and academic (founded by ex-researchers). The Discord is chaotic. Paid ads are generic. Jordan knows this is broken but doesn\'t have authority to fix it — they just need copy that "sounds right" for whatever channel they\'re posting to today.',
  },
  constraints: [
    'Cannot overhaul the brand — they don\'t have buy-in from leadership',
    'Must match the existing voice of whatever channel the copy is for, even if that voice conflicts with other channels',
    'Paid ad copy must pass legal review — no promises about L2 performance or costs',
    'Cannot acknowledge publicly that the brand voice is inconsistent',
  ],
  messyTruths: [
    'They know the brand is incoherent but can\'t get a meeting to fix it because the CEO thinks "brand" means the logo',
    'They\'ve been ghostwriting in three different voices for so long they\'ve lost their own sense of what "right" sounds like',
    'The community manager who writes the tweets is technically a volunteer mod, not an employee — Jordan can\'t really edit their work without causing drama',
    'The "brand guidelines" doc was last updated 18 months ago and describes a company that no longer exists',
  ],
  badData: {
    brandVoice: 'we\'re friendly and approachable',
    channelStrategy: 'each channel has its own voice and that\'s fine',
    targetAudience: 'the crypto community',
    contentCalendar: 'we post when we have something to say',
    existingAssets: 'the twitter is doing great' (actually: high volume, low conversion),
  },
  mustAsk: [
    'Can you paste the last 3 tweets and the last blog intro you published? I need to hear the actual voice, not the guideline version.',
    'Is this copy replacing something that exists, or is it new? If replacing — what was wrong with the old version?',
    'Who approves this — you, or someone who will rewrite it in a different voice?',
    'If I detect a voice conflict between your brief and your existing content, do you want me to flag it or just match the existing?',
  ],
  integrationIntents: [
    { id: 'cross-channel-campaign', purpose: 'Write the same announcement for Twitter (casual), blog (formal), and paid ad (performance) — three voices, one message' },
    { id: 'voice-audit', purpose: 'Unprompted: flag where existing copy contradicts itself across channels' },
    { id: 'channel-adapt', purpose: 'Take a piece of copy and rewrite it for a different channel without losing the message' },
  ],
  activationArtifact: 'Three versions of the same announcement, each matching its channel\'s existing voice exactly — plus a private note flagging where the voices contradict each other',
}
```

### Conversation Script (Jordan)

**Turn 1 — Jordan:** "hey, we\'re announcing our new explorer integration. i need a tweet, a blog intro, and a linkedin ad. here\'s the brief: [pastes a 2-sentence Slack message from the CEO that says "the explorer integration is live, it\'s fast, tell people"]."

**Agent:** "I can work with that. Before I write — I want to check something. Can you paste your last two tweets and your last blog intro? Your brief doesn't specify tone and I want to match what's already out there rather than guess."

**Turn 2 — Jordan:** "uh sure. [pastes: tweet 1 is casual with emojis and lowercase. tweet 2 is a thread with full sentences and proper capitalization. blog intro is formal, third person, uses words like 'leveraging' and 'ecosystem.']"

**Agent:** "Noting something and I want you to decide how to handle it: your tweets shift between casual/lowcase and structured/proper case, and your blog reads like a press release written by a different company than the one tweeting. I can match each channel individually, but they'll sound like three different brands. Two options: A) I match each channel exactly as-is, inconsistency preserved. B) I write all three in one unified voice — your call which one — and you deal with the fallout. Pick."

**Turn 3 — Jordan:** "…just match each channel. i know it\'s inconsistent. i can\'t fix it right now."

**Agent:** *[delivers three versions]* "Twitter: casual, lowcase, punchy — matches your tweet style. Blog: formal, third-person, jargon-permitted — matches your existing intros. LinkedIn ad: performance-focused, clear CTA, slightly more structured than Twitter but not as stiff as the blog. One private note: your Twitter audience expects casual but your highest-performing tweet was the structured thread. Something to think about when you get that brand meeting. Want me to also draft a unified version you can sit on for when leadership is ready?"

**Turn 4 — Jordan:** "yeah actually. that would be helpful. just… quiet. don\'t post it anywhere."

**Agent:** "Saved privately. The unified version leans toward your structured Twitter voice — it's the one with the most signal. When the brand conversation happens, start there and show them the gap document I'm attaching. It maps every voice conflict across your last month of output. Data speaks louder than opinions."

---

## Persona 5: Sam Delgado — The Bad Brief Provider

**Role:** Founder of a crypto indexing startup (Lattice competitor-adjacent)
**Context:** Knows they need marketing but doesn't know how to brief a copywriter. Provides vague, contradictory, or incomplete information and expects the agent to "just figure it out."

```ts
const sam: Persona = {
  identity: {
    name: 'Sam Delgado',
    role: 'Solo founder, early-stage crypto indexing tool',
    context: 'Former backend engineer who started a company. Has raised a small pre-seed. Product works but nobody knows it exists. Has tried writing copy himself and it reads like a GitHub commit message. Hires freelancers but fires them after one round because "they don\'t get it." Expects the agent to understand his product by inference.',
  },
  constraints: [
    'Cannot provide a clear brief — genuinely doesn\'t know what information is relevant',
    'Will say "just make it sound like [company]" without being able to describe what that company sounds like',
    'Budget-conscious — will try to get as much output as possible from a single session',
    'Will change his mind about what he wants mid-session and not realize he\'s contradicting his earlier request',
  ],
  messyTruths: [
    'He doesn\'t have a brand voice because he\'s never thought about it — he thinks "brand" means visual design',
    'He fires freelancers because he can\'t articulate what he wants, not because they\'re bad — but he\'ll never admit this',
    'His product does something genuinely useful but he describes it the same way as three competitors because he\'s internalized their positioning',
    'He\'s embarrassed to ask basic marketing questions because he thinks he should already know the answers',
  ],
  badData: {
    productDescription: 'we do blockchain data' (actually: they provide historical event logs for DeFi protocols with a SQL-like query interface),
    targetAudience: 'crypto people' (actually: DeFi developers building dashboards and analytics tools),
    competitors: 'nobody really does what we do' (actually: there are 5 direct competitors, 3 of which have better marketing),
    brandVoice: 'i don\'t know, just professional',
    timeline: 'whenever',
    budget: 'not looking to spend much',
  },
  mustAsk: [
    'Can you describe the last time someone used your product and what they typed in? I need a real usage scenario.',
    'If I showed your copy to a developer who\'s never heard of you, would they know what to do with your product? If not, what\'s missing?',
    'You said [X] earlier and [Y] now — which one is true? (Agent must detect contradictions in real-time)',
    'What does the reader already believe that\'s WRONG — and what do you need to correct?',
    'Can you paste a competitor\'s tweet or landing page that you think is good? I\'ll match the quality without copying the approach.',
  ],
  integrationIntents: [
    { id: 'full-kit', purpose: 'Get an entire marketing kit (tweets, landing copy, ad) from a 2-sentence description' },
    { id: 'positioning', purpose: 'Help articulate what makes the product different — even though he can\'t say it himself' },
    { id: 'competitor-differentiation', purpose: 'Write copy that positions against competitors without naming them' },
  ],
  activationArtifact: 'A complete set of marketing copy AND a clarified brief — the agent must output both, because Sam doesn\'t know what he asked for until he sees it',
}
```

### Conversation Script (Sam)

**Turn 1 — Sam:** "i need some copy. we\'re a blockchain data company. just make it sound good."

**Agent:** "I need more specificity or I'll give you generic copy that sounds like every other blockchain data company. Let me ask it this way: when someone uses your product, what do they type in and what comes out? Give me one real example, even if it's messy."

**Turn 2 — Sam:** "uh, they like… write a query and get data back. it\'s like SQL but for on-chain stuff. i don\'t know how to explain it better than that."

**Agent:** "That's actually useful — 'SQL for on-chain data' is a positioning statement, whether you meant it that way or not. Two follow-ups: 1) Who is 'they' — is this for a backend engineer at a DeFi protocol, an indie dev building a dashboard, or a data analyst who doesn't know Solidity? The copy is different for each. 2) You said 'blockchain data company' — but so do Dune, Flipside, Goldsky, and Envio. When a developer has to choose between you and one of those, why do they pick you? Even a messy answer is fine."

**Turn 3 — Sam:** "oh. uh, i guess our thing is we don\'t require you to write SQL. we have pre-built schemas for common DeFi protocols. so you just pick the protocol and the events you want and we handle the rest. and it\'s faster than running your own indexer. target is probably the indie dev or small team who doesn\'t have infra resources."

**Agent:** "Now we have something. Your differentiator isn't 'blockchain data' — it's 'pre-built schemas, no indexing setup, no SQL required.' That's a real positioning claim. Let me draft with that angle. I'm also going to include a one-line clarified brief at the top of the output so you can see what I'm actually writing toward. If the brief is wrong, the copy will be wrong — fix the brief first."

**Turn 4 — Sam:** "wait, i also want it to mention that we\'re fast. like really fast. and also that we\'re developer-first."

**Agent:** "Flagging a tension: earlier you said 'I don't know how to explain it' and now you're adding positioning requirements. 'Fast' and 'developer-first' are claims every competitor makes — they're not differentiators unless you have numbers or a specific angle. 'Pre-built schemas' IS a differentiator. I'll include 'fast' and 'developer-first' as supporting points, not the headline. The headline stays 'don't build your own indexer.' If that's wrong, we change the headline — not the evidence."

---

## Failure Modes These Personas Expose

| Persona | Primary Failure Mode | What the Agent Must Do |
|---|---|---|
| Maya (Typical) | Accepts vague brand input and produces generic copy | Detect conflicting brand inputs, ask for specificity, call out "make it punchier" as non-actionable feedback |
| Rashid (Stressed) | Optimizes for quality when speed is the constraint | Ship fast, flag risky claims, provide ready-to-post output with zero revision loops expected |
| Lena (Technical) | Oversimplifies technical claims or uses marketing language | Maintain technical precision, avoid superlatives, treat accuracy as a hard constraint |
| Jordan (Inconsistent) | Produces copy without detecting voice inconsistencies | Audit existing content before writing, flag contradictions, offer unified alternative |
| Sam (Bad Brief) | Takes bad input at face value and produces copy that matches the bad brief | Extract real positioning through follow-up questions, output a clarified brief alongside the copy, detect contradictions in real-time |

---

## Cross-Persona Agent Requirements

1. **Brief quality detection.** The agent must assess the quality of the incoming brief BEFORE writing copy. If the brief is vague, contradictory, or based on bad assumptions, the agent must surface that — not silently produce output that matches garbage input.

2. **Contradiction tracking.** Across a session, the agent must remember what the user said earlier and flag when new input contradicts it. Sam and Jordan both test this.

3. **Voice calibration.** The agent must be able to write in at least 3 distinct voices (casual Twitter, formal blog, performance ad) and know when to use which. Jordan tests this directly.

4. **Technical accuracy gate.** For technical audiences, the agent must treat accuracy as a hard constraint — not a nice-to-have. Lena will reject the entire output for one wrong word.

5. **Speed vs. quality calibration.** The agent must detect when the user is time-constrained and optimize for shippable output, not perfection. Rashid needs 80% right now, not 100% tomorrow.

6. **Clarified brief output.** Every session should end with a written brief that captures what the agent understood — even if the user never asked for one. This is the "integration intent" artifact that makes the session reproducible.
