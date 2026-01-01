require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 3000;

// --- 1. SETUP FIREBASE ADMIN ---
let serviceAccount;

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
  
  const secretKey = req.headers['x-cron-secret'];
  if (secretKey !== process.env.CRON_SECRET) {
    return res.status(401).send('Unauthorized: Sai mã bí mật!');
  }

  try {
    console.log('🔄 Bắt đầu quét các món sắp hết hạn...');

    const now = new Date();
    const tomorrowStart = new Date(now);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    tomorrowStart.setHours(0, 0, 0, 0);

    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setHours(23, 59, 59, 999);

    console.log(`🔎 Tìm món hết hạn từ: ${tomorrowStart.toISOString()} đến ${tomorrowEnd.toISOString()}`);

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

    for (const doc of snapshot.docs) {
      const itemData = doc.data();
      const itemName = itemData.name || 'Món ăn';
      const householdId = itemData.household_id;

      if (!householdId) continue;

      const houseDoc = await db.collection('households').doc(householdId).get();
      
      if (houseDoc.exists) {
        const members = houseDoc.data().members || [];
        
        for (const uid of members) {
          const userDoc = await db.collection('users').doc(uid).get();
          
          if (userDoc.exists) {
            const userData = userDoc.data();
            const fcmToken = userData.fcm_token; // Lưu ý: Code Mobile đang lưu là fcm_token (snake_case)

            if (fcmToken && fcmToken.length > 10) {
              
              const message = {
                notification: {
                  title: 'Cảnh báo hết hạn! ⏳',
                  body: `"${itemName}" sẽ hết hạn vào ngày mai. Nấu món gì đó ngay nhé!`,
                },
                // [CẬP NHẬT QUAN TRỌNG] Gửi dữ liệu điều hướng chuẩn
                data: {
                  action_id: 'FIND_RECIPE',  // Định danh hành động
                  ingredient: itemName       // Tên nguyên liệu cần tìm
                },
                token: fcmToken,
              };

              try {
                await admin.messaging().send(message);
                console.log(`📲 Đã gửi FCM tới User: ${uid} (Món: ${itemName})`);
                sentCount++;
              } catch (err) {
                console.error(`❌ Lỗi gửi tin tới ${uid}:`, err.message);
              }
            } else {
              console.log(`⚠️ User ${uid} chưa có FCM Token.`);
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

app.get('/', (req, res) => {
  res.send('Notification Server is LIVE! 🚀');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});