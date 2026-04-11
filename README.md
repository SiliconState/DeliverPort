# DeliverPort

**Share work. Get paid on-chain.**

DeliverPort is a client delivery portal for freelancers, agencies, and studios who want to share deliverables with clients and get paid in USDC on Base.

## What it does

1. **Create projects** for each client engagement
2. **Share portal links** — clients see progress, download deliverables
3. **Invoice in USDC** — payable on Base L2
4. **Live FX** — display amounts in 200+ currencies while settling in stablecoins
5. **Delivery packaging** — CSV, JSON, HTML bundle downloads for clients

## Architecture

Single HTML file. No build step. No framework. Runs entirely in the browser.

| Layer | Tech |
|-------|------|
| UI | Tailwind CSS + vanilla JS |
| Database | PGlite (Postgres WASM) |
| Auth | Local email/password with PBKDF2 |
| Payments | USDC/USDT on Base via viem |
| FX | @fawazahmed0/currency-api |
| Deploy | GitHub Pages |

## Quick start

```bash
open index.html
# or
python3 -m http.server 8080
```

## Live

[siliconstate.github.io/DeliverPort](https://siliconstate.github.io/DeliverPort/)

## License

Proprietary. All rights reserved.
