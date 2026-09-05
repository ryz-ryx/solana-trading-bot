"""
Backtest + Monte Carlo — run with:
  set SUPABASE_URL=https://luyqzjtudahhijvawbol.supabase.co
  set SUPABASE_SERVICE_KEY=<your service key>
  python analyze.py
"""
import os, sys, json, math, random, urllib.request

URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')

if not URL or not KEY:
    print("ERROR: set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars first")
    sys.exit(1)

def fetch(endpoint, params=''):
    req = urllib.request.Request(
        f"{URL}/rest/v1/{endpoint}?{params}",
        headers={'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Accept': 'application/json'}
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

print("Fetching trades from Supabase...")
trades = fetch('paper_trades', 'action=eq.sell&select=strategy,pnl_sol,pnl_pct,amount_sol,created_at&order=created_at.asc')
all_buys = fetch('paper_trades', 'action=eq.buy&select=strategy,amount_sol,created_at')

print(f"Found {len(trades)} closed trades, {len(all_buys)} open buys\n")

if not trades:
    print("No closed trades yet. Let the bot run a few more cycles and try again.")
    sys.exit(0)

# ── BACKTEST ────────────────────────────────────────────────────────────────
def backtest(t_list, label):
    pnls = [t['pnl_sol'] or 0 for t in t_list]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    total = sum(pnls)
    win_rate = len(wins)/len(pnls) if pnls else 0
    avg_win = sum(wins)/len(wins) if wins else 0
    avg_loss = sum(losses)/len(losses) if losses else 0
    profit_factor = sum(wins)/abs(sum(losses)) if losses else float('inf')

    # Sharpe (annualised, assume 1 trade/day)
    mean = total/len(pnls)
    variance = sum((p-mean)**2 for p in pnls)/len(pnls)
    stddev = math.sqrt(variance) if variance > 0 else 1e-9
    sharpe = (mean/stddev)*math.sqrt(365)

    # Max drawdown
    peak, running, mdd = 0, 0, 0
    for p in pnls:
        running += p
        if running > peak: peak = running
        mdd = max(mdd, peak - running)

    print(f"{'─'*40}")
    print(f"  {label} BACKTEST")
    print(f"{'─'*40}")
    print(f"  Closed trades : {len(pnls)}")
    print(f"  Win rate      : {win_rate*100:.1f}%")
    print(f"  Total PnL     : {total:+.4f} SOL")
    print(f"  Avg win       : {avg_win:+.4f} SOL")
    print(f"  Avg loss      : {avg_loss:+.4f} SOL")
    print(f"  Profit factor : {profit_factor:.2f}")
    print(f"  Max drawdown  : {mdd:.4f} SOL")
    print(f"  Sharpe ratio  : {sharpe:.2f}")
    print()
    return pnls

# ── MONTE CARLO ─────────────────────────────────────────────────────────────
def monte_carlo(pnls, label, runs=10000):
    if len(pnls) < 5:
        print(f"  {label}: only {len(pnls)} trades — need ≥5 for Monte Carlo\n")
        return
    results = []
    n = len(pnls)
    for _ in range(runs):
        sample = [random.choice(pnls) for _ in range(n)]
        results.append(sum(sample))
    results.sort()
    profitable = sum(1 for r in results if r > 0)
    p5  = results[int(runs*0.05)]
    p50 = results[int(runs*0.50)]
    p95 = results[int(runs*0.95)]
    rate = profitable/runs
    target = "✅ TARGET MET" if rate >= 0.60 else "❌ BELOW 60%"

    print(f"{'─'*40}")
    print(f"  {label} MONTE CARLO ({runs:,} runs)")
    print(f"{'─'*40}")
    print(f"  Profit rate   : {rate*100:.1f}% {target}")
    print(f"  Median PnL    : {p50:+.4f} SOL")
    print(f"  5th pctile    : {p5:+.4f} SOL  (worst case)")
    print(f"  95th pctile   : {p95:+.4f} SOL  (best case)")
    print()

strategies = {t['strategy'] for t in trades}
for strat in sorted(strategies):
    strat_trades = [t for t in trades if t['strategy'] == strat]
    pnls = backtest(strat_trades, strat.upper())
    monte_carlo(pnls, strat.upper())

# Overall
all_pnls = backtest(trades, 'ALL STRATEGIES')
monte_carlo(all_pnls, 'ALL STRATEGIES')

print(f"Open positions : {len(all_buys)}")
