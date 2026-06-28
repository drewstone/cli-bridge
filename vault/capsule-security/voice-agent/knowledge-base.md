# Capsule Security Voice Agent — Knowledge Base

## Company Facts

- **Name:** Capsule Security
- **Founded:** 2025
- **Stage:** Seed, ~8 employees
- **Founder:** Daniel Roth
- **Product:** Runtime guardrails for AI agents. Detects and stops rogue or compromised agents before they execute harmful actions.
- **Deployment model:** Runs inside the customer's agent infrastructure (not a proxy or API gateway).
- **Pricing model:** Per protected agent, month-to-month. Annual contracts available. Exact quote requires scoping call with Daniel.
- **Website:** [To be added by founder]
- **Calendly / booking link:** [To be added by founder]

## What Capsule Does — One Sentence

We inspect every action an AI agent attempts against a policy you write, and stop the action before it executes if it violates that policy.

## Technical Architecture (for informed prospects)

- **Policy engine:** Customer-defined rules (e.g., "this agent may not write to the production database," "this agent may only call APIs in allow-list X").
- **Anomaly detection:** Baselines normal agent behavior and flags deviations without requiring explicit rules.
- **Kill switch:** Hard stop on agent execution before the action reaches external systems.
- **Audit trail:** Immutable log of every agent action, decision, and policy evaluation for compliance and forensics.
- **Integration:** Works with major agent frameworks (LangChain, AutoGPT, custom orchestrators) via a lightweight SDK.

## Competitors — Honest Positioning

### Lakera
- **What they do:** Prompt-layer security — input validation, prompt injection detection, data loss prevention at the LLM input.
- **Capsule delta:** Lakera guards the front door. We guard the runtime. An attack that bypasses the prompt layer via a compromised plugin or memory context is invisible to Lakera but visible to Capsule.
- **Status:** Active. Well-funded. Strong in Europe.

### Protect AI
- **What they do:** ML model security — scanning models for vulnerabilities, supply-chain risk, model cards.
- **Capsule delta:** Protect AI secures the model file. We secure the agent's behavior at runtime. A clean model can still execute a malicious action if the agent's context is poisoned.
- **Status:** Active. Recently acquired by [verify — status may have changed].

### HiddenLayer
- **What they do:** AI model detection and response — adversarial ML, model inference monitoring.
- **Capsule delta:** HiddenLayer focuses on the model layer. We focus on the agent orchestration layer — the tools, APIs, and environments the agent touches.
- **Status:** Verify before citing. Competitor list is stale; this company may have pivoted.

### General positioning
"Most security teams we talk to have a prompt firewall or an approval workflow. The gap we see is when the attack lives in a plugin, a memory context, or a compromised tool configuration — never touching the prompt layer. That's the runtime gap."

## Attack Scenarios (for hooks and discovery)

1. **Compromised plugin / tool:** A third-party vector-store connector or CI/CD plugin injects a malicious instruction into the agent's tool context. The agent executes it because it appears to come from a trusted tool.
2. **Privilege escalation via memory:** An attacker poisons the agent's long-term memory store. On the next task, the agent recalls the poisoned instruction and escalates its own privileges.
3. **Shadow action chains:** The agent breaks a sensitive task into sub-tasks that individually look benign but collectively exfiltrate data or modify production systems.
4. **Insider override:** A developer with legitimate access pushes a policy override through a backdoor in the agent's configuration. Static scans pass because the code is syntactically valid.

## Customer Evidence

- **Closed deals:** None yet. Do not cite customer counts, logos, or revenue.
- **Design partners:** [To be added by founder]
- **Pilot conversations:** [To be added by founder]

If asked for social proof: "We're in pilot conversations with [N] security teams. I'm not at liberty to name them yet, but Daniel can share more on the briefing call."

## Compliance and Certifications

- **SOC 2:** In progress. Type II expected Q3 2026.
- **GDPR:** Compliant data handling. No customer data retained post-call unless explicitly requested.
- **Recording consent:** All calls recorded with explicit verbal consent. No opt-out continuation.
- **DNC:** National DNC Registry scrubbed before every campaign. Internal suppression list maintained.

## Common Objections and Responses

### "We already have a security solution for AI."
"Most teams we talk to have a prompt firewall or an approval workflow. The gap we see is when the agent bypasses both because the attack lives in a plugin or a memory context, not the prompt. Is that a gap you've tested for?"

### "This sounds like SIEM / DLP."
"SIEMs see the logs after the action happens. DLP sees data movement. We stop the agent's action before it executes. It's preventive, not detective."

### "We're not deploying AI agents yet."
"Understood. When do you expect to move from pilot to production? I'd rather send you the brief now so you have it when the question comes up."

### "Send me an email."
"Will do. What email should I use?" Confirm and read it back. "You'll get it within two minutes. If it hits spam, my email is [agent email]."

### "How much does it cost?"
"We price per protected agent, month to month. I don't have the exact quote for your scale — Daniel handles that on the briefing call."

### "Who else are you working with?"
"We're in pilot conversations with security teams in [sector, if known]. I'm not at liberty to name them yet, but Daniel can share more on the call."

### "This is a bad time."
"Fair. I'll send the two-sentence summary to [email] and a calendar link. You can book when it makes sense or ignore it entirely. What email should I use?"

## Target ICP (for context, not to read aloud)

- **Title:** CISO, VP Security, Director of Security Operations, Head of AI Governance
- **Company size:** 200–5,000 employees (security team large enough to have an AI-agent initiative, small enough that the CISO still answers calls)
- **Technographic:** Deploying or piloting AI agents in production. Using LangChain, AutoGPT, custom orchestrators, or embedded AI tools (Copilot, etc.).
- **Signal:** Recent job postings for AI/ML security, public mentions of AI-agent initiatives, conference talks, new AI-product launches.
- **Geography:** North America primary. English-speaking calls only.

## Booking and Handoff

- **BDR name:** [To be added by founder]
- **BDR email:** [To be added by founder]
- **BDR phone:** [To be added by founder]
- **Daniel's calendar:** [To be added by founder]
- **Meeting duration:** 15 minutes
- **Meeting title:** "Capsule Security — Technical briefing: runtime agent guardrails"
