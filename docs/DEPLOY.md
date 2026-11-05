# LedgerShot 部署（黑客松提交用）

评委看到的产品：报价静帧或配音单，USDC 锁进程序金库，交付哈希与报价一致才放款，失败从同一本账退回。

当前 devnet 上的程序可能仍是 **v1**（可执行，但 `release` 不核对哈希）。本仓库 `programs/ledger_shot` 是 **v1.2**：写入 `spec_hash` 与 `expected_hash`，`release` 在哈希不一致时失败，mint 固定为 Circle devnet USDC，`sync_funded` 要求金库金额与报价完全相等。提交前必须用升级权限部署，否则评委自己发交易时仍会看到旧行为。

## 0. 链上身份（不要猜）

| 项 | 值 |
| --- | --- |
| 集群 | devnet |
| Program id | `2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx` |
| 升级权限 | `2ASr3Aa2mJZPsU5FFfwJvcoHhy8GT9gY4gZw4EYPX4oD` |
| USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`（Circle devnet，6 位小数） |
| 浏览器 | https://explorer.solana.com/address/2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx?cluster=devnet |

已上线页面上如果写过别的 program id，以这一行为准。Program keypair 只对应 program id，**不是**升级权限。不要把 `ledger_shot-keypair.json` 提交进公开仓库，也不要贴进文档。

## 1. 工具链

```bash
solana --version    # 2.x，与 Anchor 0.31 匹配即可
anchor --version    # 必须是 0.31.1
rustc --version
node --version      # 22
```

```bash
# 没有 Anchor 0.31.1 时
cargo install --git https://github.com/solana-foundation/anchor avm --force
avm install 0.31.1
avm use 0.31.1
```

```bash
solana config set --url devnet
solana address
```

`solana address` 的输出必须是 `2ASr3Aa2mJZPsU5FFfwJvcoHhy8GT9gY4gZw4EYPX4oD`。不是的话，换上那把升级钱包再继续。用别的钥匙部署会失败，或变成一次新的部署，program id 就和前端对不上。

```bash
solana balance
# 低于 2 SOL 时
solana airdrop 2
```

## 2. 编译并升级程序

在仓库根目录（有 `Anchor.toml` 的那一层）：

```bash
anchor keys sync
anchor build
# declare_id! 与 target/deploy 的 program id 必须仍是
# 2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx
anchor deploy --provider.cluster devnet --program-name ledger_shot
```

`anchor keys sync` 如果想改 program id，停下来。这个程序已经在 devnet 上，只能升级，不能换 id。

等价的原生命令（`anchor deploy` 失败时再用）：

```bash
solana program deploy target/deploy/ledger_shot.so \
  --program-id 2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx \
  --url devnet
```

确认：

```bash
solana program show 2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx --url devnet
```

`Authority` 仍应是上面的升级地址，`Last Deployed In Slot` 应是刚才的新 slot。把新的 `target/idl/ledger_shot.json` 留在仓库里。旧 IDL 描述的是 v1，不要再交出去。

v1.1 账户顺序（评委或脚本对得上即可）：

1. `init_job(job_id: [u8;16], amount: u64, deadline_unix: i64, spec_hash: [u8;32], expected_hash: [u8;32])`
   - merchant 签名并付租金
   - payer 不签名，写入 PDA seeds
   - mint = devnet USDC
   - job PDA seeds = `["job", payer, job_id]`
   - vault = job 的 ATA
2. 同一笔或下一笔：付款人 ATA → vault 的 SPL Transfer，金额等于 `amount`，然后 `sync_funded`（payer 签名，`has_one = payer`）
3. `release(output_hash)` 商户签名。`output_hash` 必须等于 `expected_hash`，且未过 deadline
4. `refund` 商户提前签名，或 deadline 之后任何人调用

`spec_hash = sha256("ledger-shot/v1|{sku}|{title}|{brief}|{priceAtomic}")`。`expected_hash = sha256(交付文件原文)`。前端演练用的原文是确定性的 SVG 静帧或配音台词单，所以不连钱包也能演示「篡改则拒绝」。

## 3. 前端

演练台（`/`）和工作室账本（`/ops`）都在浏览器里闭合，不依赖数据库，也不替用户签名。评委打开链接就能走完：报价 → 锁款 → 哈希一致放款；篡改哈希被拒绝 → 退款。账恒等式始终为 0。

本地：

```bash
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

生产是 TanStack Start，构建命令保持 `npm run build`（它会在有 `DATABASE_URL` 时跑迁移）。这次演练没有新的环境变量。不要新建 `.env`，不要把升级钱包放进前端。

更新 https://ledgershot.verbodesk.com/ ：把这次的 `src/routes/index.tsx`、`src/routes/ops.tsx`、`src/components/desk/`、`src/lib/chain/`、`src/lib/ledger/`、`programs/ledger_shot/src/lib.rs` 合并进原来的 Vercel 项目，推主分支，等现有项目重新部署。不要换成另一个 program id。

若原来的 Postgres 迁移（`0002_ledger.sql` 到 `0005_ops_console.sql`）还在那个项目里，留着。它们记的是链下收据，不替代程序。演练台本身不读这些表。

## 4. 交作业前 10 分钟

1. Explorer 上打开程序，确认是新 slot，且仍然可执行。
2. 打开线上的 `/`，点 **Run judge pass**。应看到：水壶静帧变为 Released，商户 +0.10 USDC；配音单先出现 `HASH_MISMATCH`，再 Refunded；三本账加总仍等于 2.00。
3. 再手点一笔：Post quote → Fund escrow → Release tampered（必须失败、金库不动）→ Refund。
4. 打开 `/ops`，给评委看费率锁定、幂等回放、死信和对账。这是量产车间，不是第二套链。
5. 提交文案用下面这一段，不要写「这个台面不广播交易」。

## 5. 可直接粘贴的提交说明

LedgerShot is the settlement desk for AI media workshops. A studio quotes a product still or a dub sheet. The client locks USDC in a Solana PDA vault. The program pays the studio only when sha256(deliverable) equals the hash committed at quote time. If the work fails or the deadline passes, the same program refunds the vault. No invoice, no custodian.

Devnet program: `2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx`. Mint: Circle devnet USDC. Instructions: `init_job`, `sync_funded`, `release`, `refund`.

The desk at `/` replays those four checks without a wallet so a judge can finish in two minutes. `/ops` is the studio book around the chain: locked fee bps, idempotent webhooks, dead-letter, and a zero-drift reconciliation.

Why it fails closed: v1.1 stores `expected_hash` on the job. `release` transfers `job.amount` only when `output_hash == expected_hash` and the deadline has not passed. The merchant cannot swap the file after the client has signed `sync_funded`. Early refund requires the merchant. After the deadline, anyone can refund.

## 6. 不要做的事

- 不要为了演示去改数据库余额。链上只认交易，链下只追加分录。
- 不要在 v1 上告诉评委「哈希已经在链上校验」。部署完成之前，只能说演练台在校验，链上校验随 v1.1 升级生效。
- 不要把 program keypair 或升级钱包放进前端仓库。
- 主网、真 USDC、审计留到黑客松之后。Devnet 足够拿奖，主网半成品会扣分。
