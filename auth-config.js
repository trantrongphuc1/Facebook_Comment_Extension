// ==========================================
// CẤU HÌNH XÁC THỰC BẢN QUYỀN TRÊN VPS
// ==========================================
const AUTH_CONFIG = {
  // Thay YOUR_VPS_IP bằng IP VPS của bạn (ví dụ: 'http://103.56.123.45:3000/api/verify')
  API_URL: 'http://42.96.4.222:3000/api/verify',
  EXTENSION_NAME: 'Auto Comment', // Khớp với cột extension_name trong bảng Licenses trên SQL Server
  STORAGE_KEY: '_ptd_license_info'
};

