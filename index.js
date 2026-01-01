require('dotenv').config(); // Load biến môi trường
const express = require('express');
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 3000;

// --- 1. CẤU HÌNH FIREBASE ADMIN ---
// Kỹ thuật này giúp bạn không bao giờ lộ file JSON lên Git.
// Khi deploy lên Render, ta sẽ nhét toàn bộ nội dung file JSON vào biến môi trường.

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Trường hợp chạy trên Render (Server thật)
  // Biến môi trường chứa chuỗi JSON -> Parse ra Object
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // Trường hợp chạy Local (Máy tính của bạn)
  // Đọc file trực tiếp
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// --- 2. API ENDPOINT (Cron-job sẽ gọi vào đây) ---
app.get('/check-expiry', async (req, res) => {
  
  // [BẢO MẬT] Kiểm tra Secret Key để tránh người lạ gọi API spam
  const secretKey = req.headers['x-cron-secret'];
  if (secretKey !== process.env.CRON_SECRET) {
    return res.status(401).send('Unauthorized: Sai mật khẩu Cron!');
  }

  try {
    console.log('🔄 Bắt đầu quét các món sắp hết hạn...');
    const messages = [];
    
    // --- LOGIC TÌM HÀNG HẾT HẠN ---
    // Ví dụ: Tìm các món hết hạn TRONG NGÀY MAI
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Convert sang định dạng lưu trong Firestore (cần khớp với cách bạn lưu ở App)
    // Giả sử bạn lưu dạng Timestamp hoặc String YYYY-MM-DD. 
    // Ở đây tôi giả định bạn lưu Timestamp. Logic này bạn cần chỉnh lại cho khớp App nhé.
    const startOfTomorrow = new Date(tomorrow.setHours(0,0,0,0));
    const endOfTomorrow = new Date(tomorrow.setHours(23,59,59,999));

    // Query vào Collection chứa đồ ăn (Ví dụ: 'inventory_items')
    const snapshot = await db.collection('households')
        // Lưu ý: Logic query Group hoặc lặp qua từng household tùy cấu trúc DB của bạn
        // Để đơn giản, tôi giả dụ bạn có collection riêng hoặc query group
        // Tạm thời query mẫu, bạn cần chỉnh sửa 'collection path' cho đúng
        .get(); 

    // *LƯU Ý QUAN TRỌNG VỚI MOBILE DEV*: 
    // Backend không có Context User, nên bạn phải tự query data chính xác.
    // Nếu data bạn nằm lồng nhau: households/{id}/items/{itemId}, bạn nên dùng CollectionGroup query.

    // CODE GIẢ LẬP GỬI THÔNG BÁO (Demo)
    // Thực tế bạn sẽ loop qua snapshot.docs để lấy token
    
    // Giả sử tìm được 1 user cần báo
    const userFcmToken = "TOKEN_CUA_USER_LAY_TU_DB"; 
    
    if (userFcmToken) {
      const message = {
        notification: {
          title: 'Cảnh báo hết hạn! 🍎',
          body: 'Sữa tươi của bạn sẽ hết hạn vào ngày mai. Nấu ngay nhé!',
        },
        data: {
          screen: '/recipe_suggestions', // Deep link để Flutter hứng
          ingredient: 'Sữa tươi'
        },
        token: userFcmToken,
      };
      
      // Gửi đi
      await admin.messaging().send(message);
      messages.push(message);
    }

    res.status(200).json({ 
      success: true, 
      processed: messages.length, 
      message: 'Đã quét và gửi thông báo xong!' 
    });

  } catch (error) {
    console.error('Lỗi:', error);
    res.status(500).send('Internal Server Error: ' + error.message);
  }
});

// --- 3. API TEST (Để biết server sống) ---
app.get('/', (req, res) => {
  res.send('Notification Server is running! 🚀');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});