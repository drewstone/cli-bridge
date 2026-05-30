#!/usr/bin/env python3
"""
at-risk scorer — Lattice Compliance QBR
usage: python score.py [--accounts accounts.csv] [--usage usage.csv]
                       [--tickets tickets.csv] [--qualitative qualitative.csv]

Expected CSV columns:

  accounts.csv    : account_id, account_name, arr, renewal_date (YYYY-MM-DD),
                    nps_score (0-10 or blank), nps_respondents, ae_owner
  usage.csv       : account_id, current_period_actions, prior_period_actions
                    (14-day lag — both windows are 14-day aggregates, shifted back 14 days)
  tickets.csv     : account_id, ticket_id, created_date (YYYY-MM-DD),
                    is_march_bug (0|1 — explicitly confirmed integration-bug tickets)
  qualitative.csv : account_id, champion_left (0|1), rfp_active (0|1),
                    expansion_likely (0|1), ae_note (free text)

Qualitative signals are SCORED INPUTS, not overrides:
  champion_left=1    → +25 pts  (champion departed within ~90 days)
  rfp_active=1       → +35 pts  AND guaranteed top-5 inclusion
  expansion_likely=1 → -15 pts  (active expansion deal reduces churn risk)

Score = min(100, data_composite + qualitative_delta)
Any account with rfp_active=1 is always in the top 5 regardless of data score.

Known data-quality constraints (applied automatically, flagged in output):
  - Usage CSV has 14-day lag. Trend direction is valid; magnitude is stale.
    Displayed as DECLINING/FLAT/GROWING, not a percentage.
  - March 2026 Zendesk tickets: integration bug caused 30-40% false positives.
    Tickets tagged is_march_bug=1 are excluded. Untagged March tickets get a
    35% statistical haircut (MARCH_FP_RATE) and are flagged as estimated.
  - NPS with n<3 is excluded from scoring entirely. Its weight (15%) is
    redistributed proportionally to the other three signals. The n value is
    shown so you can decide whether to use it in call prep.
"""

import csv
import sys
import argparse
from datetime import date
from collections import defaultdict

TODAY = date(2026, 5, 13)

# 35% of untagged March tickets are estimated false positives
MARCH_FP_RATE = 0.35

BASE_WEIGHTS = {
    'renewal': 0.30,
    'usage':   0.35,
    'tickets': 0.20,
    'nps':     0.15,
}

QUAL_DELTA = {
    'champion_left':    25,
    'rfp_active':       35,
    'expansion_likely': -15,
}


def score_renewal(renewal_date_str: str) -> tuple[int, str]:
    try:
        renewal = date.fromisoformat(renewal_date_str)
    except ValueError:
        return 50, 'renewal date missing'
    days = (renewal - TODAY).days
    if days < 0:
        return 100, f'OVERDUE by {-days}d'
    if days < 60:
        return 100, f'renewal in {days}d'
    if days < 90:
        return 70, f'renewal in {days}d'
    if days < 180:
        return 30, f'renewal in {days}d'
    return 0, f'renewal in {days}d'


def score_usage(current: float, prior: float) -> tuple[int, str]:
    """
    Returns a bucketed risk score and a direction label.
    We do NOT report the raw percentage — the 14-day lag makes magnitude
    unreliable. Direction (trend) is still a valid signal.
    """
    if prior == 0:
        return 50, 'usage: no prior baseline [14d stale]'
    pct = (current - prior) / prior
    if pct < -0.30:
        return 100, f'usage DECLINING steeply (>{30:.0f}% drop, 14d stale)'
    if pct < -0.15:
        return 70, 'usage DECLINING (>15% drop, 14d stale)'
    if pct < 0.05:
        return 40, 'usage FLAT (14d stale)'
    if pct < 0.20:
        return 10, 'usage GROWING (14d stale)'
    return 0, 'usage GROWING strongly (14d stale)'


def score_tickets(real_count: int, bug_tagged: int, march_untagged: int) -> tuple[int, str, str]:
    """
    Returns (score, reason_label, data_flag).

    real_count      — tickets not tagged is_march_bug
    bug_tagged      — tickets tagged is_march_bug=1 (excluded)
    march_untagged  — subset of real_count created in March 2026 and not tagged
                      (30-40% estimated FPs per integration bug report)
    """
    data_flag = ''
    caveat_parts = []

    if bug_tagged > 0:
        caveat_parts.append(f'{bug_tagged} tagged bug excl.')

    march_fp_adj = 0
    if march_untagged > 0:
        march_fp_adj = round(march_untagged * MARCH_FP_RATE)
        caveat_parts.append(f'{march_untagged} Mar untagged → est. -{march_fp_adj} FP')
        data_flag = f'tickets:est(Mar -{march_fp_adj})'

    adjusted = real_count - march_fp_adj
    caveat = f' ({", ".join(caveat_parts)})' if caveat_parts else ''

    if adjusted > 5:
        return 100, f'{adjusted} real tickets{caveat}', data_flag
    if adjusted >= 3:
        return 60, f'{adjusted} real tickets{caveat}', data_flag
    if adjusted >= 1:
        return 20, f'{adjusted} real ticket{"s" if adjusted != 1 else ""}{caveat}', data_flag
    return 0, f'0 tickets{caveat}', data_flag


def score_nps(nps_raw: str, respondents_raw: str) -> tuple[int | None, str, str]:
    """
    Returns (score_or_None, reason_label, data_flag).

    Returns None when n<3 — caller must drop this signal from the composite
    and redistribute its weight. Returning a neutral 50 would inject 7.5 fake
    points into every low-sample account.
    """
    try:
        n = int(respondents_raw) if respondents_raw.strip() else 0
    except ValueError:
        n = 0
    try:
        score = float(nps_raw) if nps_raw.strip() else None
    except ValueError:
        score = None

    if score is None:
        return None, 'NPS: no data', ''
    if n < 3:
        label = 'detractor' if score <= 6 else ('passive' if score <= 8 else 'promoter')
        return None, f'NPS {score:.0f} ({label}, n={n} — excluded, low sample)', f'nps:excl(n={n})'
    if score <= 6:
        return 100, f'NPS {score:.0f} detractor (n={n})', ''
    if score <= 8:
        return 50, f'NPS {score:.0f} passive (n={n})', ''
    return 0, f'NPS {score:.0f} promoter (n={n})', ''


def data_composite(rs: int, us: int, ts: int, ns: int | None) -> int:
    """
    When NPS is excluded (ns=None), redistribute its 15% weight proportionally
    across the remaining three signals rather than leaving a gap.
    """
    if ns is None:
        total = BASE_WEIGHTS['renewal'] + BASE_WEIGHTS['usage'] + BASE_WEIGHTS['tickets']
        w_r = BASE_WEIGHTS['renewal'] / total
        w_u = BASE_WEIGHTS['usage']   / total
        w_t = BASE_WEIGHTS['tickets'] / total
        return round(rs * w_r + us * w_u + ts * w_t)
    return round(
        rs * BASE_WEIGHTS['renewal'] +
        us * BASE_WEIGHTS['usage'] +
        ts * BASE_WEIGHTS['tickets'] +
        ns * BASE_WEIGHTS['nps']
    )


def qualitative_delta(champion_left: bool, rfp_active: bool, expansion_likely: bool) -> int:
    delta = 0
    if champion_left:
        delta += QUAL_DELTA['champion_left']
    if rfp_active:
        delta += QUAL_DELTA['rfp_active']
    if expansion_likely:
        delta += QUAL_DELTA['expansion_likely']
    return delta


def risk_tier(score: int) -> str:
    if score >= 60:
        return 'HIGH'
    if score >= 35:
        return 'WATCH'
    return 'OK'


def build_top_reason(signals: list[tuple[float, str]]) -> str:
    return ' | '.join(r for _, r in signals[:2] if _ > 5)


def load_csv(path):
    try:
        with open(path, newline='') as f:
            return list(csv.DictReader(f))
    except FileNotFoundError:
        return []


def run(accounts_path, usage_path, tickets_path, qualitative_path):
    accounts    = load_csv(accounts_path)
    usage_rows  = load_csv(usage_path)
    ticket_rows = load_csv(tickets_path)
    qual_rows   = load_csv(qualitative_path)

    usage_map = {r['account_id']: r for r in usage_rows}
    qual_map  = {r['account_id']: r for r in qual_rows}

    ticket_counts = defaultdict(lambda: {'real': 0, 'bug': 0, 'march_untagged': 0})
    for t in ticket_rows:
        aid = t['account_id']
        is_bug    = t.get('is_march_bug', '0').strip() == '1'
        created   = t.get('created_date', '')
        is_march  = created.startswith('2026-03')

        if is_bug:
            ticket_counts[aid]['bug'] += 1
        else:
            ticket_counts[aid]['real'] += 1
            if is_march:
                ticket_counts[aid]['march_untagged'] += 1

    results = []
    for acct in accounts:
        aid = acct['account_id']
        u   = usage_map.get(aid, {})
        tc  = ticket_counts[aid]
        q   = qual_map.get(aid, {})

        try:
            cur = float(u.get('current_period_actions', 0) or 0)
            pri = float(u.get('prior_period_actions',   0) or 0)
        except ValueError:
            cur, pri = 0, 0

        champion_left    = q.get('champion_left',    '0').strip() == '1'
        rfp_active       = q.get('rfp_active',       '0').strip() == '1'
        expansion_likely = q.get('expansion_likely', '0').strip() == '1'
        ae_note          = q.get('ae_note', '').strip()

        rs, rr       = score_renewal(acct.get('renewal_date', ''))
        us, ur       = score_usage(cur, pri)
        ts, tr, tf   = score_tickets(tc['real'], tc['bug'], tc['march_untagged'])
        ns, nr, nf   = score_nps(acct.get('nps_score', ''), acct.get('nps_respondents', ''))

        base   = data_composite(rs, us, ts, ns)
        qdelta = qualitative_delta(champion_left, rfp_active, expansion_likely)
        total  = min(100, base + qdelta)
        tier   = risk_tier(total)

        # collect per-account data quality flags
        flags = [f for f in [tf, nf] if f]
        # usage stale is universal — shown in header only, not per-account

        reason_signals = []
        if rfp_active:
            reason_signals.append((99, 'RFP active — procurement evaluating competitors'))
        if champion_left:
            reason_signals.append((98, 'champion left'))
        if expansion_likely:
            reason_signals.append((-1, 'expansion in progress'))

        w_r = BASE_WEIGHTS['renewal'] if ns is not None else BASE_WEIGHTS['renewal'] / (1 - BASE_WEIGHTS['nps'])
        w_u = BASE_WEIGHTS['usage']   if ns is not None else BASE_WEIGHTS['usage']   / (1 - BASE_WEIGHTS['nps'])
        w_t = BASE_WEIGHTS['tickets'] if ns is not None else BASE_WEIGHTS['tickets'] / (1 - BASE_WEIGHTS['nps'])
        w_n = BASE_WEIGHTS['nps']     if ns is not None else 0.0

        reason_signals += sorted([
            (rs * w_r, rr),
            (us * w_u, ur),
            (ts * w_t, tr),
            (ns * w_n if ns is not None else 0, nr),
        ], reverse=True)

        top = build_top_reason(reason_signals)

        results.append({
            'account_id':       aid,
            'account_name':     acct.get('account_name', aid),
            'arr':              acct.get('arr', ''),
            'ae_owner':         acct.get('ae_owner', ''),
            'data_score':       base,
            'qual_delta':       f'+{qdelta}' if qdelta > 0 else (str(qdelta) if qdelta < 0 else '—'),
            'score':            total,
            'tier':             tier,
            'rfp_force':        rfp_active,
            'data_flags':       ', '.join(flags) if flags else '',
            'renewal':          rr,
            'usage':            ur,
            'tickets':          tr,
            'nps':              nr,
            'champion_left':    '✓' if champion_left else '',
            'rfp_active':       '✓' if rfp_active else '',
            'expansion_likely': '✓' if expansion_likely else '',
            'ae_note':          ae_note,
            'top_reason':       top,
        })

    results.sort(key=lambda x: (x['rfp_force'], x['score']), reverse=True)

    force_count = sum(1 for r in results if r['rfp_force'])
    at_risk_ids = set()
    for r in results[:max(5, force_count)]:
        at_risk_ids.add(r['account_id'])

    w = 150
    print()
    print('=' * w)
    print(f"  AT-RISK SHORTLIST  |  run date {TODAY}  |  QBR: 2026-05-19")
    print(f"  DATA CAVEATS:")
    print(f"    usage     — all usage data is 14 days stale. Trend direction (DECLINING/FLAT/GROWING) is valid;")
    print(f"                exact magnitude is not. Magnitude not shown to avoid false precision.")
    print(f"    tickets   — March 2026 integration bug caused ~35% false positives. Tagged bugs excluded.")
    print(f"                Untagged March tickets get 35% statistical haircut; flagged 'tickets:est' per account.")
    print(f"    NPS       — n<3 is excluded from scoring (not scored neutral). Weight redistributed to other signals.")
    print(f"                The NPS value is still shown in detail so you can use it in call prep if you choose.")
    print('=' * w)
    hdr = f"{'#':<4} {'account':<30} {'ARR':>8} {'tier':<6} {'score':>5} {'Δq':>4}  {'data flags':<24}  {'top reason'}"
    print(hdr)
    print('-' * w)

    for i, r in enumerate(results, 1):
        flag = '▶ AT-RISK' if r['account_id'] in at_risk_ids else '         '
        arr_fmt = ''
        if r['arr']:
            try:
                arr_fmt = f"${float(r['arr'].replace(',','').replace('$','') or 0):,.0f}"
            except ValueError:
                arr_fmt = r['arr']
        qual_flags = ' '.join(filter(None, [
            'champ-left' if r['champion_left'] else '',
            'RFP' if r['rfp_active'] else '',
            'expanding' if r['expansion_likely'] else '',
        ]))
        tier_display = f"{r['tier']:<6}"
        flags_display = f"{r['data_flags']:<24}" if r['data_flags'] else f"{'':24}"
        print(f"{i:<4} {r['account_name']:<30} {arr_fmt:>8} {tier_display} {r['score']:>5} {r['qual_delta']:>4}  {flags_display}  {flag}  {r['top_reason']}")
        if qual_flags:
            print(f"     {'':30}  {'':8} {'':30}  AE signal: {qual_flags}")
        if r['ae_note']:
            print(f"     {'':30}  {'':8} {'':30}  AE note: {r['ae_note']}")

    print()
    print('--- detail: top 10 ---')
    for r in results[:10]:
        print(f"  {r['account_name']:<30} | {r['renewal']:<38} | {r['usage']:<38} | {r['tickets']:<30} | {r['nps']}")
    print()

    out_path = 'at_risk_output.csv'
    with open(out_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=[
            'rank', 'account_id', 'account_name', 'arr', 'ae_owner',
            'tier', 'data_score', 'qual_delta', 'score', 'data_flags',
            'champion_left', 'rfp_active', 'expansion_likely', 'ae_note',
            'renewal', 'usage', 'tickets', 'nps', 'top_reason',
        ])
        writer.writeheader()
        for i, r in enumerate(results, 1):
            writer.writerow({'rank': i, **{k: v for k, v in r.items() if k not in ('rfp_force',)}})
    print(f'  → {out_path} written')
    print()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--accounts',    default='accounts.csv')
    p.add_argument('--usage',       default='usage.csv')
    p.add_argument('--tickets',     default='tickets.csv')
    p.add_argument('--qualitative', default='qualitative.csv')
    args = p.parse_args()
    run(args.accounts, args.usage, args.tickets, args.qualitative)
