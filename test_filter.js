const fs = require('fs');
const html = fs.readFileSync('lunaliving_check.html', 'utf8');

function isJunkItem(str) {
  if (!str || typeof str !== 'string') return true;
  const s = str.trim().toLowerCase();
  if (s.length < 2 || s.length > 40) return true;
  if (/luna verified|phòng thật|đã hết phòng|phòng tương tự|tiền đặt cọc|cọc giữ|hỏi quản lý|giờ giấc|tự do|đúng giá|giá điện|giá nước|phí giữ xe|phí dịch vụ|trải nghiệm|hotline|mã căn|vị trí thực tế|google maps|tiện ích|nội thất|bàn giao|xem thêm|liên hệ|chi tiết|chia sẻ|báo cáo/i.test(s)) {
    return true;
  }
  return false;
}

// Simulated user output from before:
const rawFurnBefore = `Máy giặt chung, LUNA VERIFIED • 100% PHÒNG THẬT, Đã hết phòng - Xem các phòng tương tự, Studio (không gác), Đã hết phòng, • Đường Cầm Bá Thước, Quận Phú Nhuận, 6, 200, 000đ/tháng, Tiền đặt cọc, 000 VNĐ, Cọc giữ phòng, 2.000.000₫ (Giữ 7 ngày), Thú cưng, Hỏi quản lý tòa nhà, Giờ giấc, Tự do 100%, không chung chủ, Tiện ích tòa nhà, Cửa sổ trời, Máy lạnh, Tủ lạnh, Tủ đồ, Giường nệm, Minh bạch • Đúng giá, Giá điện, 4.000/Kwh, Giá nước sinh hoạt, 100.000/người, Phí giữ xe, Free, Phí dịch vụ, 200.000/phòng, Trải Nghiệm Trực Tiếp, Hotline hỗ trợ trực tiếp:, Phòng thật 100%, Hợp đồng rõ ràng, Không phát sinh, Mã căn: ROOM-5200, Vị trí thực tế, Đường Cầm Bá Thước, Xem vị trí trên Google Maps`;

const cleanedFurn = rawFurnBefore.split(/[,;\n]+/).map(s => s.trim()).filter(s => !isJunkItem(s));
console.log('Cleaned from junk list:', cleanedFurn);

// Simulated scoped extractor:
function extractScoped(html) {
  // Utilities
  const utilMatch = html.match(/(?:Ti&#x1EC7;n &#xED;ch t&#xF2;a nh&#xE0;|Tiện ích tòa nhà)[\s\S]*?<div class="flex flex-wrap gap-2">([\s\S]*?)<\/div>\s*<\/div>/i);
  let utilities = [];
  if (utilMatch) {
    utilities = [...utilMatch[1].matchAll(/<span>([^<]+)<\/span>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim())
      .filter(s => !isJunkItem(s));
  }

  // Furniture
  const furnMatch = html.match(/(?:N&#x1ED9;i th&#x1EA5;t b&#xE0;n giao|Nội thất bàn giao)[\s\S]*?<div class="grid grid-cols-2 gap-2[^"]*">([\s\S]*?)<\/div>\s*<\/div>/i);
  let furniture = [];
  if (furnMatch) {
    furniture = [...furnMatch[1].matchAll(/<span class="truncate">([^<]+)<\/span>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim())
      .filter(s => !isJunkItem(s));
  }

  return { utilities, furniture };
}

console.log('Scoped extraction:', extractScoped(html));

