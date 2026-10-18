'use strict';
/**
 * 生成桌面端图标。
 *
 * 两种来源，按可用性自动选：
 *
 * 1. **小鲸鱼挂件的萌宠立绘**（默认）——`dsh-whale-widget` 包里 `assets/DSniang1.png`，
 *    也就是 Web 界面右下角那只可点击的萌宠本体（抠图透明底，气泡由插件代码绘制）。
 * 2. **程序化绘制**（兜底）——找不到素材或找不到图像库时，画深蓝圆角方块 + 白色波浪，
 *    保证克隆本项目的人不装任何东西也能跑出图标。
 *
 * 产出：
 * - `build/icon.ico`      —— 打包用，**多尺寸**（16/24/32/48/64/128/256）。
 *                            只放一张 256 交给 Windows 缩到 32px 会糊，角色立绘尤其明显。
 * - `src/assets/icon.png` —— 开发运行时窗口图标与状态页图案。
 *
 * 用法：
 *   node tools/make-icon.js                        # 自动选来源
 *   node tools/make-icon.js --source <图片路径>     # 指定素材
 *   node tools/make-icon.js --mode tile            # 萌宠放在深海底色圆角方块上
 *   node tools/make-icon.js --candidates <目录>     # 额外产出候选图供人工挑选
 * @module dsh-desktop/tools/make-icon
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
/** ICO 内打包的尺寸档位。 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** 抠图模式下的四周留白比例。 */
const MARGIN = 0.04;

const ROOT = path.join(__dirname, '..');

// ---- PNG 编码 ----

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * 把 RGBA 像素编码成 PNG。
 * @param width - 宽。
 * @param height - 高。
 * @param rgba - 长度 width*height*4 的像素缓冲。
 * @returns PNG 文件内容。
 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 把若干尺寸的 PNG 打成多尺寸 ICO。
 *
 * Vista 起 ICO 允许直接内嵌 PNG 载荷，省掉 BMP + AND 掩码那套老格式；每个尺寸
 * 各自用 lanczos 缩好，比让 Windows 从 256 硬缩清晰得多。
 * @param entries - `[{ size, png }]`。
 * @returns ICO 文件内容。
 */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const directory = [];
  const payloads = [];
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    directory.push(entry);
    payloads.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...directory, ...payloads]);
}

// ---- 兜底：程序化绘制 ----

/** 圆角矩形的内部判定（坐标归一化到 0..1）。 */
function insideRoundedRect(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** 点到一段正弦波的距离，用于画出有粗细的波浪描边。 */
function distanceToWave(x, y, { amplitude, offset, phase, from, to }) {
  if (x < from || x > to) return Infinity;
  const t = (x - from) / (to - from);
  return Math.abs(y - (offset + amplitude * Math.sin(t * Math.PI * 2 + phase)));
}

/**
 * 程序化绘制兜底图标：深蓝→紫圆角方块 + 两道白浪 + 一个点。
 * @param size - 边长。
 * @returns PNG 内容。
 */
function renderProcedural(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const from = [0x4d, 0x6b, 0xfe];
  const to = [0x8f, 0x6b, 0xff];
  const samples = 3;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (!insideRoundedRect(x, y, 0.22)) continue;
          const mix = Math.min(1, Math.max(0, (x + y) / 2));
          let cr = from[0] + (to[0] - from[0]) * mix;
          let cg = from[1] + (to[1] - from[1]) * mix;
          let cb = from[2] + (to[2] - from[2]) * mix;
          const halfWidth = 0.042;
          const ramp = 0.018;
          const waveDist = Math.min(
            distanceToWave(x, y, { amplitude: 0.075, offset: 0.545, phase: 0, from: 0.17, to: 0.84 }),
            distanceToWave(x, y, { amplitude: 0.05, offset: 0.715, phase: 0.85, from: 0.17, to: 0.84 }),
          );
          const dotDist = Math.hypot(x - 0.34, y - 0.3);
          const clamp01 = (value) => Math.max(0, Math.min(1, value));
          const coverage = Math.max(clamp01((halfWidth - waveDist) / ramp), clamp01((0.055 - dotDist) / ramp));
          if (coverage > 0) {
            cr += (255 - cr) * coverage;
            cg += (255 - cg) * coverage;
            cb += (255 - cb) * coverage;
          }
          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }
      const total = samples * samples;
      const index = (py * size + px) * 4;
      const covered = a === 0 ? 1 : a / 255;
      rgba[index] = Math.round(r / covered);
      rgba[index + 1] = Math.round(g / covered);
      rgba[index + 2] = Math.round(b / covered);
      rgba[index + 3] = Math.round(a / total);
    }
  }
  return encodePng(size, size, rgba);
}

// ---- 图像库与素材定位 ----

const GLOBAL_ROOT = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules') : null;

/**
 * 找一个可用的 sharp。本项目自身不依赖它，优先用 dsh 自带的那份。
 * @returns sharp 模块，或 null。
 */
function loadSharp() {
  const candidates = [
    'sharp',
    GLOBAL_ROOT && path.join(GLOBAL_ROOT, '@deepseek-ai', 'dsh', 'node_modules', 'sharp'),
    GLOBAL_ROOT && path.join(GLOBAL_ROOT, 'sharp'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/**
 * 定位萌宠立绘：环境变量 → 已安装的 dsh-whale-widget 包。
 * @returns 图片绝对路径，或 null。
 */
function locateMascot() {
  const explicit = process.env.DSH_DESKTOP_MASCOT;
  if (typeof explicit === 'string' && explicit.trim() !== '' && fs.existsSync(explicit)) return explicit;
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
  const roots = [
    path.join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-whale-widget'),
    path.join(dshHome, 'profiles', 'node_modules', 'dsh-whale-widget'),
  ];
  for (const root of roots) {
    const asset = path.join(root, 'assets', 'DSniang1.png');
    if (fs.existsSync(asset)) return asset;
  }
  return null;
}

// ---- 立绘 → 图标 ----

/**
 * 求出不透明内容的外接框。
 *
 * 用很低的 alpha 阈值（8），把柔和的投影和光晕一并留住；sharp 自带的 trim 是拿
 * 左上角像素色去比，抠图素材边缘有半透明过渡时容易切多。
 * @param sharp - sharp 模块。
 * @param file - 图片路径。
 * @returns `{ left, top, width, height }`。
 */
async function alphaBounds(sharp, file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width;
  let y0 = info.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { left: 0, top: 0, width: info.width, height: info.height };
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * 深海底色圆角方块（tile 模式），色系取自皮肤夜间主视觉。
 * @param size - 边长。
 * @returns SVG 内容。
 */
function tileSvg(size) {
  const radius = Math.round(size * 0.22);
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
       <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="#1b2740"/><stop offset="1" stop-color="#2b2140"/>
       </linearGradient></defs>
       <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="url(#g)"/>
     </svg>`,
  );
}

/**
 * 从已裁好的立绘生成指定尺寸的图标 PNG。
 * @param sharp - sharp 模块。
 * @param source - 已裁到内容外接框的图（Buffer）。
 * @param size - 目标边长。
 * @param mode - `cutout`（透明底）或 `tile`（圆角方块底）。
 * @returns PNG 内容。
 */
async function renderFromCutout(sharp, source, size, mode) {
  const inner = mode === 'tile' ? Math.round(size * 0.86) : Math.round(size * (1 - MARGIN * 2));
  const fitted = await sharp(source).resize(inner, inner, { fit: 'inside', kernel: 'lanczos3' }).toBuffer({ resolveWithObject: true });
  const left = Math.round((size - fitted.info.width) / 2);
  const top = Math.round((size - fitted.info.height) / 2);
  const layers = [];
  if (mode === 'tile') layers.push({ input: tileSvg(size), left: 0, top: 0 });
  layers.push({ input: fitted.data, left, top });
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers)
    .png()
    .toBuffer();
}

// ---- 主流程 ----

function parseArgs(argv) {
  const options = { mode: 'cutout', source: null, candidates: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') options.source = argv[i + 1];
    else if (arg.startsWith('--source=')) options.source = arg.slice('--source='.length);
    else if (arg === '--mode') options.mode = argv[i + 1];
    else if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length);
    else if (arg === '--candidates') options.candidates = argv[i + 1];
    else if (arg.startsWith('--candidates=')) options.candidates = arg.slice('--candidates='.length);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const icoPath = path.join(ROOT, 'build', 'icon.ico');
  const pngPath = path.join(ROOT, 'src', 'assets', 'icon.png');
  fs.mkdirSync(path.dirname(icoPath), { recursive: true });
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });

  const sharp = loadSharp();
  const source = options.source ?? locateMascot();

  if (sharp === null || source === null || !fs.existsSync(source)) {
    process.stdout.write(`[make-icon] 退回程序化绘制（${sharp === null ? '找不到 sharp' : `找不到素材 ${String(source)}`}）\n`);
    const png = renderProcedural(SIZE);
    fs.writeFileSync(pngPath, png);
    fs.writeFileSync(icoPath, encodeIco(ICO_SIZES.map((size) => ({ size, png: renderProcedural(size) }))));
    process.stdout.write(`icon.png  ${String(png.length)} bytes -> ${pngPath}\n`);
    process.stdout.write(`icon.ico  多尺寸 ${ICO_SIZES.join('/')} -> ${icoPath}\n`);
    return;
  }

  const bounds = await alphaBounds(sharp, source);
  const cutout = await sharp(source).extract(bounds).png().toBuffer();
  process.stdout.write(
    `[make-icon] 素材 ${path.basename(source)}：内容外接框 ${String(bounds.width)}x${String(bounds.height)}（原图 (${String(bounds.left)},${String(bounds.top)}) 起）\n`,
  );

  if (options.candidates) {
    fs.mkdirSync(options.candidates, { recursive: true });
    for (const [name, mode] of [['1-mascot-cutout', 'cutout'], ['2-mascot-tile', 'tile']]) {
      for (const size of [256, 32]) {
        const png = await renderFromCutout(sharp, cutout, size, mode);
        const file = path.join(options.candidates, `icon-${name}-${String(size)}.png`);
        fs.writeFileSync(file, png);
        process.stdout.write(`候选 ${name} @${String(size)}px -> ${file}\n`);
      }
    }
  }

  const png256 = await renderFromCutout(sharp, cutout, SIZE, options.mode);
  fs.writeFileSync(pngPath, png256);
  const entries = [];
  for (const size of ICO_SIZES) entries.push({ size, png: await renderFromCutout(sharp, cutout, size, options.mode) });
  fs.writeFileSync(icoPath, encodeIco(entries));
  process.stdout.write(`icon.png  ${String(png256.length)} bytes -> ${pngPath}\n`);
  process.stdout.write(`icon.ico  多尺寸 ${ICO_SIZES.join('/')}，模式 ${options.mode} -> ${icoPath}\n`);
}

main().catch((error) => {
  console.error(`[make-icon] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
