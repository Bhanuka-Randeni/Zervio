const express = require('express');
const path = require('path');

const app = express();

// Middleware - No Multer needed since we aren't writing local files
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Data Store
let systemConfig = {
    shopName: "Gourmet Kitchen",
    backgroundImage: "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1200" // Default Web URL
};

let categories = ["Appetizers", "Main Course", "Desserts", "Beverages"];

let menu = [
    { 
        id: 1, 
        name: "Classic Beef Burger", 
        category: "Main Course", 
        price: 12.99, 
        stock: 15, 
        rating: 4.5, 
        ratingsCount: 2, 
        image: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=500" // Real Photo URL
    },
    { 
        id: 2, 
        name: "Crispy French Fries", 
        category: "Appetizers", 
        price: 4.99, 
        stock: 4, 
        rating: 4.0, 
        ratingsCount: 1, 
        image: "https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=500" // Real Photo URL
    }
];

let tables = ["T1", "T2", "T3", "T4", "T5"];
let orders = [];
let waiterSummons = [];
let billRequests = [];
let prepTimeEstimate = "15-20 mins";

// --- API Endpoints ---

// Global Settings
app.get('/api/config', (req, res) => res.json({ config: systemConfig, categories, tables, prepTimeEstimate }));
app.post('/api/admin/config', (req, res) => {
    if (req.body.shopName) systemConfig.shopName = req.body.shopName;
    if (req.body.wallpaperUrl) systemConfig.backgroundImage = req.body.wallpaperUrl; // Accept URL text string
    res.redirect('/admin.html');
});

// Categories Management
app.post('/api/categories', (req, res) => {
    const { name } = req.body;
    if (name && !categories.includes(name)) categories.push(name);
    res.json({ success: true, categories });
});

// Menu Management
app.get('/api/menu', (req, res) => res.json(menu));
app.post('/api/admin/menu', (req, res) => {
    const { id, name, category, price, stock, foodImageUrl } = req.body;
    
    if (id) {
        // Edit Mode
        const item = menu.find(m => m.id == id);
        if (item) {
            item.name = name;
            item.category = category;
            item.price = parseFloat(price);
            item.stock = parseInt(stock);
            if (foodImageUrl) item.image = foodImageUrl;
        }
    } else {
        // Add Mode
        const newItem = {
            id: menu.length + 1,
            name,
            category,
            price: parseFloat(price),
            stock: parseInt(stock),
            rating: 0,
            ratingsCount: 0,
            image: foodImageUrl || "https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=500"
        };
        menu.push(newItem);
    }
    res.redirect('/admin.html');
});

// Table & QR Management
app.post('/api/admin/tables', async (req, res) => {
    const { tableName } = req.body;
    if (tableName && !tables.includes(tableName)) {
        tables.push(tableName);
    }
    res.redirect('/admin.html');
});

app.get('/api/qr/generate', async (req, res) => {
    const { table } = req.query;
    if (!table) return res.status(400).send("Table missing");
    
    const host = req.get('host');
    const qrUrl = `https://${host}/customer.html?table=${table}`;
    
    try {
        // Dynamically load qrcode package only when called to keep serverless cold-starts light
        const QRCode = require('qrcode');
        const qrImageBuffer = await QRCode.toDataURL(qrUrl);
        res.json({ qrDataUrl: qrImageBuffer, targetUrl: qrUrl });
    } catch (err) {
        res.status(500).send("Error generating QR");
    }
});

// Customer Rating System
app.post('/api/menu/rate', (req, res) => {
    const { itemId, rating } = req.body;
    const item = menu.find(m => m.id == itemId);
    if (item) {
        const newRating = parseFloat(rating);
        const totalScore = (item.rating * item.ratingsCount) + newRating;
        item.ratingsCount += 1;
        item.rating = parseFloat((totalScore / item.ratingsCount).toFixed(1));
        return res.json({ success: true, item });
    }
    res.status(404).json({ success: false, message: "Item not found" });
});

// Order Pipeline Management
app.get('/api/orders', (req, res) => res.json(orders));

app.post('/api/orders/place', (req, res) => {
    const { table, items } = req.body;
    
    let orderItems = [];
    for(let cartItem of items) {
        const menuItem = menu.find(m => m.id == cartItem.id);
        if(menuItem) {
            if(menuItem.stock < cartItem.qty) {
                return res.status(400).json({ success: false, message: `Insufficient stock for ${menuItem.name}` });
            }
            menuItem.stock -= cartItem.qty;
            orderItems.push({
                id: menuItem.id,
                name: menuItem.name,
                price: menuItem.price,
                qty: cartItem.qty,
                note: cartItem.note || ""
            });
        }
    }

    const newOrder = {
        id: 'ORD-' + Date.now(),
        table,
        items: orderItems,
        status: 'Pending Cashier',
        timestamp: new Date()
    };
    orders.push(newOrder);
    res.json({ success: true, order: newOrder });
});

// Workflow Updates
app.post('/api/orders/update-status', (req, res) => {
    const { orderId, status, waiterId } = req.body;
    const order = orders.find(o => o.id === orderId);
    if (order) {
        order.status = status;
        if(waiterId) order.waiterId = waiterId;
        return res.json({ success: true, order });
    }
    res.status(404).json({ success: false });
});

app.post('/api/kitchen/time', (req, res) => {
    if(req.body.time) prepTimeEstimate = req.body.time;
    res.json({ success: true, prepTimeEstimate });
});

// Waiter Assistance Pipeline
app.post('/api/waiter/summon', (req, res) => {
    const { table } = req.body;
    const summon = { id: 'SUM-' + Date.now(), table, status: 'Active' };
    waiterSummons.push(summon);
    res.json({ success: true });
});

app.get('/api/waiter/summons', (req, res) => res.json(waiterSummons));

app.post('/api/waiter/summon/clear', (req, res) => {
    const { id } = req.body;
    waiterSummons = waiterSummons.filter(s => s.id !== id);
    res.json({ success: true });
});

app.post('/api/bill/request', (req, res) => {
    const { table } = req.body;
    if(!billRequests.find(b => b.table === table && b.status !== 'Settled')) {
        billRequests.push({ id: 'BILL-' + Date.now(), table, status: 'Pending Cashier' });
    }
    res.json({ success: true });
});

app.get('/api/bills', (req, res) => res.json(billRequests));

app.post('/api/bills/update', (req, res) => {
    const { id, status, waiterId } = req.body;
    const bill = billRequests.find(b => b.id === id);
    if(bill) {
        bill.status = status;
        if(waiterId) bill.waiterId = waiterId;
        return res.json({ success: true });
    }
    res.status(404).json({ success: false });
});

// Export app for Vercel Serverless
module.exports = app;