# MSSQL Comment Assistant

Web app để lưu comment template, ảnh, và queue URL bài viết vào MSSQL Server.

## Cấu trúc dữ liệu
- `CommentTemplates`: lưu tiêu đề, nội dung comment, URL mặc định, ghi chú.
- `TemplateImages`: lưu ảnh trong `varbinary(max)` gắn với template.
- `CommentJobs`: lưu job chạy theo URL post.
- `CommentJobLogs`: lưu log trạng thái job.

## Cài đặt
1. Tạo database bằng script trong `config/schema.sql`.
2. Copy `.env.example` thành `.env` và sửa thông tin MSSQL.
3. Cài dependencies:

```bash
npm install
```

4. Chạy app:

```bash
npm start
```

5. Mở `http://localhost:3000`.

## Biến môi trường
- `PORT`
- `MSSQL_CONNECTION_STRING`
- `MSSQL_SERVER`
- `MSSQL_PORT`
- `MSSQL_DATABASE`
- `MSSQL_USER`
- `MSSQL_PASSWORD`
- `MSSQL_ENCRYPT`
- `MSSQL_TRUST_CERT`

Ưu tiên dùng `MSSQL_CONNECTION_STRING` nếu bạn đã có chuỗi kết nối đầy đủ, ví dụ:

```text
Server=(localdb)\\mssqllocaldb;Database=CommentAssistant;Trusted_Connection=True;MultipleActiveResultSets=true
```

Nếu không có biến này thì app sẽ dùng các biến rời `MSSQL_SERVER`, `MSSQL_PORT`, `MSSQL_DATABASE`, `MSSQL_USER`, `MSSQL_PASSWORD`.

## Lưu ý
- Ảnh đang được lưu trực tiếp trong MSSQL bằng `varbinary(max)`.
- Phần chạy comment thực tế nên nối bằng browser extension hoặc worker riêng. Source này tập trung vào quản lý dữ liệu, ảnh, và job queue.
