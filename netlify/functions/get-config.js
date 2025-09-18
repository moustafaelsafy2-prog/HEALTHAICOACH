// يرجّع config.json بدون أي توثيق
const fs = require('fs/promises');
const path = require('path');

exports.handler = async () => {
  try {
    // نقرأ ملف config.json من مجلد النشر (الجذر حسب netlify.toml)
    const filePath = path.join(process.cwd(), 'config.json');
    const buf = await fs.readFile(filePath, 'utf8');
    // تحقّق أن المحتوى JSON صالح
    JSON.parse(buf);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      },
      body: buf
    };
  } catch (e) {
    // رجوع افتراضي لو الملف غير موجود
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({})
    };
  }
};
