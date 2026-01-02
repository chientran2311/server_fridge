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

// --- 2. API QUÉT HẾT HẠN ---
app.get('/check-expiry', async (req, res) => {
  
  const secretKey = req.headers['x-cron-secret'];
  if (secretKey !== process.env.CRON_SECRET) {
    return res.status(401).send('Unauthorized: Sai mã bí mật!');
  }

  try {
    console.log('🔄 Bắt đầu quét các món sắp hết hạn...');

    // 1. Xác định khung giờ ngày mai
    const now = new Date();
    const tomorrowStart = new Date(now);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    tomorrowStart.setHours(0, 0, 0, 0);

    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setHours(23, 59, 59, 999);

    console.log(`🔎 Tìm từ: ${tomorrowStart.toISOString()} đến ${tomorrowEnd.toISOString()}`);

    // 2. Query tìm món ăn
    const snapshot = await db.collectionGroup('inventory')
      .where('expiry_date', '>=', tomorrowStart)
      .where('expiry_date', '<=', tomorrowEnd)
      .get();

    if (snapshot.empty) {
      console.log('✅ Không có món nào hết hạn vào ngày mai.');
      return res.status(200).send('No items expiring tomorrow.');
    }

    console.log(`📦 Tìm thấy ${snapshot.size} món sắp hết hạn.`);

    // --- LOGIC GOM NHÓM (NEW) ---
    // Cấu trúc Map: { userId: { token:String, items: [String] } }
    const userNotifications = {}; 

    for (const doc of snapshot.docs) {
      const itemData = doc.data();
      const itemName = itemData.name || 'Món ăn';
      const householdId = itemData.household_id;

      if (!householdId) continue; // Bỏ qua nếu món lỗi data

      // Lấy thông tin Household để tìm Members
      const houseDoc = await db.collection('households').doc(householdId).get();
      
      if (houseDoc.exists) {
        const members = houseDoc.data().members || [];
        
        // Lặp qua từng thành viên trong nhà
        for (const uid of members) {
          // Nếu user này chưa có trong danh sách gửi, thì fetch token
          if (!userNotifications[uid]) {
            const userDoc = await db.collection('users').doc(uid).get();
            if (userDoc.exists) {
              const userData = userDoc.data();
              const token = userData.fcm_token;
              
              if (token && token.length > 10) {
                userNotifications[uid] = {
                  token: token,
                  items: [] 
                };
              }
            }
          }

          // Nếu user đã tồn tại (và có token), thêm món ăn vào danh sách của họ
          if (userNotifications[uid]) {
            userNotifications[uid].items.push(itemName);
          }
        }
      }
    }

    // --- GỬI THÔNG BÁO (Sau khi đã gom nhóm) ---
    let sentCount = 0;
    const userIds = Object.keys(userNotifications);
    console.log(`📨 Chuẩn bị gửi cho ${userIds.length} users.`);

    for (const uid of userIds) {
      const data = userNotifications[uid];
      const items = data.items; // List tên các món: ['Thịt bò', 'Sữa', 'Trứng']
      const firstItem = items[0];
      const otherCount = items.length - 1;

      // Tạo nội dung thông báo thông minh
      let title = 'Cảnh báo hết hạn! ⏳';
      let body = '';

      if (items.length === 1) {
        body = `"${firstItem}" sẽ hết hạn vào ngày mai. Nấu món gì đó ngay nhé!`;
      } else {
        body = `"${firstItem}" và ${otherCount} món khác sẽ hết hạn vào ngày mai. Kiểm tra tủ lạnh ngay!`;
      }

      // Payload gửi đi
      const message = {
        notification: {
          title: title,
          body: body,
        },
        data: {
          action_id: 'FIND_RECIPE',
          // Gửi tên món đầu tiên để App gợi ý công thức cho món đó
          ingredient: firstItem 
        },
        token: data.token,
      };

      try {
        await admin.messaging().send(message);
        console.log(`✅ Sent to ${uid}: ${body}`);
        sentCount++;
      } catch (err) {
        console.error(`❌ Fail to send ${uid}:`, err.message);
      }
    }

    res.status(200).json({
      success: true,
      message: `Đã xử lý xong. Gửi thành công tới ${sentCount} users.`,
    });

  } catch (error) {
    console.error('🔥 Lỗi Server:', error);
    res.status(500).send('Internal Server Error: ' + error.message);
  }
});

app.get('/', (req, res) => {
  res.send('Notification Server is LIVE (Grouped Mode)! 🚀');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});