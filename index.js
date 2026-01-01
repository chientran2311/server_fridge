require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 3000;

// --- 1. SETUP FIREBASE ADMIN ---
let serviceAccount;

// Tự động nhận diện môi trường (Render hay Local)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// --- 2. API QUÉT HẾT HẠN (CRON-JOB GỌI VÀO ĐÂY) ---
app.get('/check-expiry', async (req, res) => {
  
  // [BẢO MẬT] Kiểm tra mã bí mật từ Cron-job
  const secretKey = req.headers['x-cron-secret'];
  if (secretKey !== process.env.CRON_SECRET) {
    return res.status(401).send('Unauthorized: Sai mã bí mật!');
  }

  try {
    console.log('🔄 Bắt đầu quét các món sắp hết hạn...');

    // --- A. TÍNH TOÁN THỜI GIAN (NGÀY MAI) ---
    // Món 'inv_01' trong seeder của bạn hết hạn sau 1 ngày -> Sẽ rơi vào khoảng này
    const now = new Date();
    const tomorrowStart = new Date(now);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    tomorrowStart.setHours(0, 0, 0, 0);

    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setHours(23, 59, 59, 999);

    console.log(`🔎 Tìm món hết hạn từ: ${tomorrowStart.toISOString()} đến ${tomorrowEnd.toISOString()}`);

    // --- B. QUERY FIRESTORE (COLLECTION GROUP) ---
    // Dùng collectionGroup('inventory') để quét xuyên qua tất cả các households
    // Khớp với cấu trúc: households/{id}/inventory/{itemId}
    const snapshot = await db.collectionGroup('inventory')
      .where('expiry_date', '>=', tomorrowStart)
      .where('expiry_date', '<=', tomorrowEnd)
      .get();

    if (snapshot.empty) {
      console.log('✅ Không có món nào hết hạn vào ngày mai.');
      return res.status(200).send('No items expiring tomorrow.');
    }

    console.log(`📦 Tìm thấy ${snapshot.size} món sắp hết hạn.`);
    let sentCount = 0;

    // --- C. XỬ LÝ GỬI THÔNG BÁO ---
    for (const doc of snapshot.docs) {
      const itemData = doc.data();
      
      // Lấy thông tin từ Seeder: 'name' và 'household_id'
      const itemName = itemData.name || 'Món ăn';
      const householdId = itemData.household_id;

      if (!householdId) continue;

      // 1. Lấy thông tin Household để tìm Members
      const houseDoc = await db.collection('households').doc(householdId).get();
      
      if (houseDoc.exists) {
        // Seeder: members là mảng UID ['user_seed_01', ...]
        const members = houseDoc.data().members || [];
        
        // 2. Lặp qua từng thành viên để lấy Token
        for (const uid of members) {
          const userDoc = await db.collection('users').doc(uid).get();
          
          if (userDoc.exists) {
            // Seeder: fcm_token nằm trong users
            const userData = userDoc.data();
            const fcmToken = userData.fcm_token;

            // Chỉ gửi nếu có Token (User đã đăng nhập App)
            if (fcmToken && fcmToken.length > 10) {
              
              const message = {
                notification: {
                  title: 'Cảnh báo hết hạn! ⏳',
                  body: `"${itemName}" sẽ hết hạn vào ngày mai. Nấu món gì đó ngay nhé!`,
                },
                // Data để App Flutter hứng và Deep Link
                data: {
                  screen: '/recipe_suggestions', 
                  ingredient: itemName // Truyền tên món (VD: Thịt bò) để gợi ý công thức
                },
                token: fcmToken,
              };

              try {
                await admin.messaging().send(message);
                console.log(`📲 Đã gửi FCM tới User: ${uid} (Món: ${itemName})`);
                sentCount++;
              } catch (err) {
                console.error(`❌ Lỗi gửi tin tới ${uid}:`, err.message);
                // Nếu lỗi "Registration token not registered", nên xóa token khỏi DB
              }
            } else {
              console.log(`⚠️ User ${uid} chưa có FCM Token (Chưa login app trên máy thật).`);
            }
          }
        }
      }
    }

    res.status(200).json({
      success: true,
      message: `Đã xử lý xong. Gửi thành công ${sentCount} thông báo.`,
    });

  } catch (error) {
    console.error('🔥 Lỗi Server:', error);
    res.status(500).send('Internal Server Error: ' + error.message);
  }
});

// Trang chủ để biết Server còn sống
app.get('/', (req, res) => {
  res.send('Notification Server is LIVE! 🚀');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});