require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 10000; // Render thường dùng port 10000

// --- 1. SETUP FIREBASE ADMIN ---
let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch (error) {
  console.error("🔥 Lỗi Init Firebase:", error.message);
}

const db = admin.firestore();

// --- 2. API QUÉT HẾT HẠN ---
app.get('/check-expiry', async (req, res) => {
  
  const secretKey = req.headers['x-cron-secret'];
  // Lưu ý: So sánh secret, nếu chưa config env thì tạm bỏ qua để debug
  if (process.env.CRON_SECRET && secretKey !== process.env.CRON_SECRET) {
    return res.status(401).send('Unauthorized: Sai mã bí mật!');
  }

  try {
    console.log('🔄 [START] Bắt đầu quét các món sắp hết hạn...');

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

    // --- LOGIC GOM NHÓM ---
    const userNotifications = {}; 

    for (const doc of snapshot.docs) {
      const itemData = doc.data();
      const itemName = itemData.name || 'Món ăn';
      const householdId = itemData.household_id;

      // [DEBUG LOG 1] Kiểm tra Household ID
      if (!householdId) {
        console.log(`⚠️ Món "${itemName}" (${doc.id}) bị thiếu household_id!`);
        continue; 
      }

      const houseDoc = await db.collection('households').doc(householdId).get();
      
      if (!houseDoc.exists) {
        console.log(`⚠️ Không tìm thấy Household ID: ${householdId} cho món "${itemName}"`);
        continue;
      }

      const members = houseDoc.data().members || [];
      if (members.length === 0) {
        console.log(`⚠️ Nhà ${householdId} không có thành viên nào.`);
      }
        
      for (const uid of members) {
        // Fetch User nếu chưa có trong cache tạm
        if (!userNotifications[uid]) {
          const userDoc = await db.collection('users').doc(uid).get();
          
          if (userDoc.exists) {
            const userData = userDoc.data();
            const token = userData.fcm_token;
            
            // [DEBUG LOG 2] Kiểm tra Token
            if (token && token.length > 10) {
              userNotifications[uid] = {
                token: token,
                items: [] 
              };
            } else {
              console.log(`⚠️ User ${uid} tìm thấy nhưng KHÔNG CÓ TOKEN hợp lệ.`);
            }
          } else {
             console.log(`⚠️ User ID ${uid} có trong nhà nhưng không tồn tại trong collection users.`);
          }
        }

        // Nếu user hợp lệ, push món ăn vào
        if (userNotifications[uid]) {
          userNotifications[uid].items.push(itemName);
        }
      }
    }

    // --- GỬI THÔNG BÁO ---
    let sentCount = 0;
    const userIds = Object.keys(userNotifications);
    console.log(`📨 Chuẩn bị gửi cho ${userIds.length} users hợp lệ.`);

    if (userIds.length === 0) {
      console.log("🛑 Dừng lại: Không tìm thấy user nào có Token để gửi.");
      return res.status(200).send('Found items but no valid users/tokens found.');
    }

    for (const uid of userIds) {
      const data = userNotifications[uid];
      const items = data.items; 
      const firstItem = items[0];
      const otherCount = items.length - 1;

      let title = 'Cảnh báo hết hạn! ⏳';
      let body = '';

      if (items.length === 1) {
        body = `"${firstItem}" sẽ hết hạn vào ngày mai. Dùng ngay nhé!`;
      } else {
        body = `"${firstItem}" và ${otherCount} món khác sẽ hết hạn vào ngày mai.`;
      }

      const message = {
        notification: { title: title, body: body },
        data: {
          action_id: 'FIND_RECIPE',
          ingredient: firstItem 
        },
        token: data.token,
      };

      try {
        await admin.messaging().send(message);
        console.log(`✅ Đã gửi tới ${uid}: ${body}`);
        sentCount++;
      } catch (err) {
        console.error(`❌ Gửi thất bại tới ${uid}:`, err.message);
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
  res.send('Notification Server is LIVE (Debug Mode)! 🚀');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});