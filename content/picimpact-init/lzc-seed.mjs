// 懒猫微服 · PicImpact 幂等种子脚本（在应用容器内、服务启动后执行）
//
// 职责（全部幂等、失败只记日志不抛出）：
//   1. 等应用 HTTP 起来；
//   2. 用应用自身的 better-auth 注册接口创建审核账号（已存在则跳过）；
//   3. 在 configs 表写入内置对象存储（RustFS）的接入配置（仅在为空时写入，尊重用户后续修改）；
//   4. 创建存储桶并设置「匿名只读」桶策略（写操作仍需预签名）。
//
// 运行环境：在 picimpact 容器内以镜像默认用户执行（node 24 + /app/node_modules）。
import { createRequire } from 'node:module';
import process from 'node:process';

const req = createRequire('/app/package.json');
const { PrismaClient } = req('@prisma/client');
const {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketPolicyCommand,
} = req('@aws-sdk/client-s3');

const log = (...a) => console.log('[lzc-seed]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EP = process.env.LZC_S3_ENDPOINT || '';
const AK = process.env.LZC_S3_ACCESS_KEY || 'picimpact';
const SK = process.env.LZC_S3_SECRET_KEY || '';
const BUCKET = process.env.LZC_S3_BUCKET || 'picimpact';
const ADMIN_EMAIL = process.env.LZC_ADMIN_EMAIL || '';
const ADMIN_PW = process.env.LZC_ADMIN_PASSWORD || '';
// better-auth 对注册/登录接口要求 Origin 且校验受信来源：
// 用应用自身的公开域名作为 Origin（= BETTER_AUTH_URL 的 origin）。
const ORIGIN = process.env.LZC_DOMAIN ? `https://${process.env.LZC_DOMAIN}` : 'http://127.0.0.1:3000';

async function waitHttp(timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:3000/', { redirect: 'manual' });
      if (r.status < 500) return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

async function ensureAdmin() {
  if (!ADMIN_EMAIL || !ADMIN_PW) {
    log('admin: env missing, skip');
    return;
  }
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PW, name: 'admin' }),
      });
      const text = await r.text();
      if (r.ok) {
        log('admin created:', ADMIN_EMAIL);
        return;
      }
      if (/exist/i.test(text)) {
        log('admin exists:', ADMIN_EMAIL);
        return;
      }
      log('admin warn', r.status, text.slice(0, 160));
      // 触发登录节流时限流窗口后重试，避免把节流窗口连续续上
      if (r.status === 429) {
        await sleep(20000);
        continue;
      }
    } catch (e) {
      log('admin retry', i, e.name || e.message);
    }
    await sleep(3000);
  }
  log('admin: gave up');
}

async function ensureConfigs(prisma) {
  const want = {
    endpoint: EP,
    accesskey_id: AK,
    accesskey_secret: SK,
    region: 'us-east-1',
    bucket: BUCKET,
    storage_folder: '',
    force_path_style: 'true',
    s3_cdn: 'false',
    s3_cdn_url: '',
    s3_direct_download: 'false',
    custom_title: 'PicImpact',
  };
  // 注意：上游 prisma seed 会预填一批默认值（如 force_path_style='false'），
  // 单纯「仅空值填充」会被这些默认值绕过。对与内置存储强绑定的关键开关做强制校正，
  // 其余键保持「仅空值填充」，尊重用户后续修改。
  const FORCE_KEYS = { force_path_style: 'true' };
  const rows = await prisma.configs.findMany({});
  const map = new Map(rows.map((r) => [r.config_key, r]));
  for (const [k, v] of Object.entries(want)) {
    const row = map.get(k);
    if (!row) {
      await prisma.configs.create({ data: { config_key: k, config_value: String(v), detail: 'lzc' } });
      log('config created:', k);
    } else if (FORCE_KEYS[k] !== undefined && String(row.config_value) !== FORCE_KEYS[k]) {
      await prisma.configs.update({ where: { config_key: k }, data: { config_value: FORCE_KEYS[k] } });
      log('config fixed:', k, '->', FORCE_KEYS[k]);
    } else if (!row.config_value || String(row.config_value).trim() === '') {
      await prisma.configs.update({ where: { config_key: k }, data: { config_value: String(v) } });
      log('config filled:', k);
    }
  }
}

async function ensureBucket() {
  if (!EP || !SK) {
    log('bucket: env missing, skip');
    return;
  }
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: EP,
    credentials: { accessKeyId: AK, secretAccessKey: SK },
    forcePathStyle: true,
  });
  for (let i = 0; i < 60; i++) {
    try {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
        log('bucket created:', BUCKET);
      }
      await s3.send(
        new PutBucketPolicyCommand({
          Bucket: BUCKET,
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { AWS: ['*'] },
                Action: ['s3:GetObject'],
                Resource: [`arn:aws:s3:::${BUCKET}/*`],
              },
            ],
          }),
        }),
      );
      log('bucket policy ok (anonymous read-only)');
      return;
    } catch (e) {
      if (i % 5 === 0) log('bucket wait', i, e.name || e.message);
    }
    await sleep(3000);
  }
  log('bucket: gave up');
}

async function main() {
  try {
    const up = await waitHttp();
    log('http up:', up);
    if (!up) return;
    await ensureAdmin();
  } catch (e) {
    log('admin step failed:', e.name || e.message);
  }
  try {
    const prisma = new PrismaClient();
    await ensureConfigs(prisma);
    await prisma.$disconnect();
  } catch (e) {
    log('configs step failed:', e.name || e.message);
  }
  try {
    await ensureBucket();
  } catch (e) {
    log('bucket step failed:', e.name || e.message);
  }
  log('done');
}

main().catch((e) => log('fatal:', e.name || e.message));
