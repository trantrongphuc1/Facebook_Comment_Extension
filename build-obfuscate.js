const fs = require('fs');
const path = require('path');

let JavaScriptObfuscator;
try {
  JavaScriptObfuscator = require('javascript-obfuscator');
} catch (e) {
  try {
    JavaScriptObfuscator = require(path.join(__dirname, '..', 'Up Post', 'node_modules', 'javascript-obfuscator'));
  } catch (err) {
    console.error('❌ Chưa tìm thấy thư viện javascript-obfuscator. Vui lòng chạy lệnh: npm install');
    process.exit(1);
  }
}

const SOURCE_DIR = __dirname;
const DIST_DIR = path.join(__dirname, 'dist_protected');

// Danh sách các file JavaScript cần nghiền nát bảo mật tối đa
const JS_FILES_TO_OBFUSCATE = [
  'auth-config.js',
  'popup.js',
  'content.js',
  'background.js'
];

// Danh sách file/folder tài nguyên cần copy sang dist
const ASSETS_TO_COPY = [
  'manifest.json',
  'popup.html',
  'icon.png',
  'logo.png',
  '6bed233b-6879-4800-ad31-1958705756ea.png'
];

// Cấu hình nghiền nát mã nguồn cấp độ CAO NHẤT (High Security)
const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.8,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  numbersToExpressions: true,
  simplify: true,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.8,
  splitStrings: true,
  splitStringsChunkLength: 10,
  transformObjectKeys: true,
  selfDefending: true,             // Tự làm hỏng code nếu khách cố tình dùng Prettier / Format để đọc
  debugProtection: true,           // Đóng băng tab nếu khách cố tình mở F12 Inspect
  debugProtectionInterval: 2500,
  disableConsoleOutput: true       // Ẩn toàn bộ log console
};

async function build() {
  console.log('🚀 [1/3] Đang dọn dẹp và tạo thư mục xuất xưởng dist_protected...');
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });

  console.log('📦 [2/3] Đang sao chép tài nguyên (HTML, Ảnh, Manifest)...');
  for (const item of ASSETS_TO_COPY) {
    const srcPath = path.join(SOURCE_DIR, item);
    const destPath = path.join(DIST_DIR, item);
    if (!fs.existsSync(srcPath)) continue;

    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyFolderSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
    console.log(`   + Đã sao chép: ${item}`);
  }

  console.log('🔒 [3/3] Đang NGHIỀN NÁT (Obfuscate) toàn bộ mã nguồn JavaScript...');
  for (const jsFile of JS_FILES_TO_OBFUSCATE) {
    const srcPath = path.join(SOURCE_DIR, jsFile);
    const destPath = path.join(DIST_DIR, jsFile);

    if (!fs.existsSync(srcPath)) continue;

    console.log(`   🔥 Đang nghiền nát: ${jsFile}...`);
    const sourceCode = fs.readFileSync(srcPath, 'utf8');

    // Chế độ riêng cho content script & background để đảm bảo tương thích manifest v3
    let options = { ...OBFUSCATOR_OPTIONS };
    if (jsFile === 'content.js' || jsFile === 'background.js') {
      // Giảm bớt selfDefending ở background/content để Service Worker và DOM chạy trơn tru
      options.selfDefending = false;
      options.debugProtection = false;
    }

    const obfuscationResult = JavaScriptObfuscator.obfuscate(sourceCode, options);
    fs.writeFileSync(destPath, obfuscationResult.getObfuscatedCode(), 'utf8');
    console.log(`   ✅ Đã khóa an toàn: ${jsFile}`);
  }

  console.log('\n==========================================================');
  console.log('🎉 XUẤT XƯỞNG THÀNH CÔNG VÀO THƯ MỤC: dist_protected');
  console.log('👉 Toàn bộ mã nguồn đã bị biến thành chuỗi mã hóa không thể đọc!');
  console.log('==========================================================\n');
}

function copyFolderSync(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from).forEach((element) => {
    const src = path.join(from, element);
    const dest = path.join(to, element);
    if (fs.lstatSync(src).isDirectory()) {
      copyFolderSync(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  });
}

build();

