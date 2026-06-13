import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, collection, query, where, onSnapshot, doc, runTransaction, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// 1. Firebase Configuration (Replace with your actual config)
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "your-app.firebaseapp.com",
  projectId: "your-app",
  storageBucket: "your-app.appspot.com",
  messagingSenderId: "123456",
  appId: "1:123456:web:abcdef"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// 2. Feature Flags Configuration
// Allows admin/developer to easily turn off features without deploying code
const featureFlags = {
    enableOnlinePayments: true,
    enableSlipUploads: false,
    showPreparationTime: true
};

// 3. Application State
let currentUserRole = null;
let currentTable = new URLSearchParams(window.location.search).get('table'); // e.g., ?table=T5
let cart = [];

// 4. View Router
function switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
}

// 5. Authentication & Role Management
onAuthStateChanged(auth, async (user) => {
    if (user) {
        // Fetch user role from Firestore
        const userDoc = await getDoc(doc(db, "users", user.uid));
        if (userDoc.exists()) {
            currentUserRole = userDoc.data().role;
            document.getElementById('role-badge').innerText = currentUserRole;
            document.getElementById('logout-btn').classList.remove('hidden');
            
            // Route based on role
            if (currentUserRole === 'kitchen') {
                switchView('view-kitchen');
                initKitchenListener();
            } else if (currentUserRole === 'waiter') {
                switchView('view-waiter');
                initWaiterListener();
            } else if (currentUserRole === 'admin' || currentUserRole === 'cashier') {
                // Admin dashboard logic would go here
            }
        }
    } else {
        // If not logged in, but there's a table in URL, they are a customer
        if (currentTable) {
            document.getElementById('current-table').innerText = currentTable;
            switchView('view-customer');
            initCustomerMenu();
        } else {
            switchView('view-login');
        }
    }
});

// --- ROLE: CUSTOMER LOGIC ---

async function initCustomerMenu() {
    // Read menu items in real-time
    const q = query(collection(db, "menu_items"), where("is_available", "==", true));
    onSnapshot(q, (snapshot) => {
        const grid = document.getElementById('menu-grid');
        grid.innerHTML = ''; // Clear existing
        snapshot.forEach((doc) => {
            const item = doc.data();
            const lowStockWarn = item.qty_available < 5 ? `<span class="low-stock">Low Stock!</span>` : '';
            
            grid.innerHTML += `
                <div class="menu-card">
                    <img src="${item.image_url || 'placeholder.jpg'}" alt="${item.name}">
                    <h4>${item.name}</h4>
                    <p class="menu-price">$${item.price.toFixed(2)}</p>
                    ${lowStockWarn}
                    <button class="btn-primary" onclick="addToCart('${doc.id}', '${item.name}', ${item.price})" ${item.qty_available === 0 ? 'disabled' : ''}>
                        Add to Cart
                    </button>
                </div>
            `;
        });
    });
}

window.addToCart = (id, name, price) => {
    cart.push({ id, name, price, notes: "" });
    document.getElementById('cart-count').innerText = cart.length;
};

// Customer Order Placement
document.getElementById('place-order').addEventListener('click', async () => {
    if (cart.length === 0) return alert("Cart is empty");
    
    const paymentMethod = document.getElementById('payment-method').value;
    const total = cart.reduce((sum, item) => sum + item.price, 0);

    try {
        await addDoc(collection(db, "orders"), {
            table_id: currentTable,
            status: "pending", // Cashier needs to confirm
            total_amount: total,
            payment_method: paymentMethod,
            items: cart,
            created_at: serverTimestamp()
        });
        
        alert("Order placed successfully! Waiting for cashier confirmation.");
        cart = []; // Reset cart
        document.getElementById('cart-modal').close();
    } catch (e) {
        console.error("Error placing order: ", e);
        alert("Failed to place order. Please try again.");
    }
});

// --- ROLE: KITCHEN LOGIC ---

function initKitchenListener() {
    // Kitchen only sees confirmed orders that are either pending prep or preparing
    const q = query(collection(db, "orders"), where("status", "in", ["confirmed", "preparing"]));
    onSnapshot(q, (snapshot) => {
        const board = document.getElementById('kitchen-orders');
        board.innerHTML = '';
        snapshot.forEach((doc) => {
            const order = doc.data();
            const itemsHtml = order.items.map(i => `<li>${i.name} ${i.notes ? `(<i>${i.notes}</i>)` : ''}</li>`).join('');
            
            board.innerHTML += `
                <div class="ticket ${order.status === 'preparing' ? 'preparing' : ''}">
                    <h3>Table ${order.table_id}</h3>
                    <ul>${itemsHtml}</ul>
                    <button class="btn-secondary" onclick="updateOrderStatus('${doc.id}', 'preparing')">Start Prep</button>
                    <button class="btn-primary" onclick="updateOrderStatus('${doc.id}', 'ready')">Mark Ready</button>
                </div>
            `;
        });
    });
}

window.updateOrderStatus = async (orderId, newStatus) => {
    await updateDoc(doc(db, "orders", orderId), { status: newStatus });
};


// --- ROLE: WAITER LOGIC (The Locking Mechanism) ---

function initWaiterListener() {
    // Waiters only see orders marked 'ready' by kitchen, and NOT currently handled by another waiter
    const q = query(collection(db, "orders"), where("status", "==", "ready"));
    onSnapshot(q, (snapshot) => {
        const list = document.getElementById('waiter-tasks');
        list.innerHTML = '';
        snapshot.forEach((docSnapshot) => {
            const order = docSnapshot.data();
            // If another waiter has claimed it, don't show it
            if (order.claimed_by && order.claimed_by !== auth.currentUser.uid) return;

            list.innerHTML += `
                <div class="menu-card" style="flex-direction: row; justify-content: space-between;">
                    <div>
                        <h3>Table ${order.table_id}</h3>
                        <p>Status: ${order.claimed_by ? 'Claimed by you' : 'Needs Serving'}</p>
                    </div>
                    ${!order.claimed_by ? 
                        `<button class="btn-primary" onclick="claimTask('${docSnapshot.id}')">Accept Task</button>` :
                        `<button class="btn-success" onclick="markServed('${docSnapshot.id}')">Mark Served</button>`
                    }
                </div>
            `;
        });
    });
}

// CRITICAL: Using Firestore Transaction to prevent two waiters from claiming the same order
window.claimTask = async (orderId) => {
    const orderRef = doc(db, "orders", orderId);
    try {
        await runTransaction(db, async (transaction) => {
            const orderDoc = await transaction.get(orderRef);
            if (!orderDoc.exists()) throw "Order does not exist!";
            
            // If someone else already claimed it in the last few milliseconds, abort
            if (orderDoc.data().claimed_by) {
                throw "Task already claimed by another waiter.";
            }

            // Lock the task to this waiter
            transaction.update(orderRef, { claimed_by: auth.currentUser.uid });
        });
        console.log("Task successfully claimed!");
    } catch (error) {
        alert(error); // Inform the waiter they missed it
    }
};

window.markServed = async (orderId) => {
    await updateDoc(doc(db, "orders", orderId), { 
        status: "served",
        served_at: serverTimestamp() 
    });
};