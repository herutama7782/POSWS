/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

// --- GLOBAL STATE & CONFIG ---
let db;
let cart = {
    items: [],
    fees: []
};
let currentImageData = null;
let currentEditImageData = null;
let currentStoreLogoData = null;
let currentPage = 'dashboard';
let confirmCallback = null;
let html5QrCode;
let currentReportData = [];
let lowStockThreshold = 5; // Default value
let isOnline = navigator.onLine;
let isSyncing = false;
let btDevice = null;
let btCharacteristic = null;


// --- DATABASE FUNCTIONS ---
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('POS_DB', 7); 

        request.onerror = function() {
            showToast('Gagal menginisialisasi database', 'error');
            reject();
        };
        
        request.onsuccess = function(event) {
            db = event.target.result;
            resolve();
        };
        
        request.onupgradeneeded = function(event) {
            db = event.target.result;
            const transaction = event.target.transaction;
            
            if (!db.objectStoreNames.contains('products')) {
                const productStore = db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
                productStore.createIndex('name', 'name', { unique: false });
                productStore.createIndex('barcode', 'barcode', { unique: false }); // Allow non-unique barcodes initially
                productStore.createIndex('categoryId', 'categoryId', { unique: false });
            }
            if (!db.objectStoreNames.contains('transactions')) {
                const transactionStore = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
                transactionStore.createIndex('date', 'date', { unique: false });
            }
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains('categories')) {
                const categoryStore = db.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
                categoryStore.createIndex('name', 'name', { unique: true });
            }
             if (!db.objectStoreNames.contains('fees')) {
                const feeStore = db.createObjectStore('fees', { keyPath: 'id', autoIncrement: true });
                feeStore.createIndex('name', 'name', { unique: true });
            }

            // Migration logic for unique barcodes if needed
            if (event.oldVersion < 7) {
                 const productStore = transaction.objectStore('products');
                if (productStore.indexNames.contains('barcode')) {
                    productStore.deleteIndex('barcode');
                }
                productStore.createIndex('barcode', 'barcode', { unique: false });
            }

            // Initialize default categories
            transaction.oncomplete = () => {
                const categoryStore = db.transaction('categories', 'readwrite').objectStore('categories');
                categoryStore.count().onsuccess = (e) => {
                    if (e.target.result === 0) {
                        ['Makanan', 'Minuman', 'Lainnya'].forEach(name => categoryStore.add({ name }));
                    }
                };
            };
        };
    });
}

// Generic DB operation wrapper
function dbRequest(storeName, mode, operation, ...args) {
    return new Promise((resolve, reject) => {
        if (!db) {
            console.error("Database not initialized.");
            return reject("Database not initialized.");
        }
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = store[operation](...args);
        
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = (event) => {
            console.error(`DB Error on ${storeName}:`, event.target.error);
            reject(event.target.error);
        };
    });
}

// --- INITIALIZATION ---
window.onload = initApp;

async function initApp() {
    try {
        await initDB();
        await loadStoreSettings();
        await Promise.all([
            loadCategories(),
            loadProductsGrid(),
            loadProductsList(),
            loadFees(),
            applyDefaultFees()
        ]);
        updateDashboard();
        updateCartView();
        setupEventListeners();
        initBluetooth();
        updateSyncStatus();
    } catch (error) {
        console.error("Initialization failed:", error);
        document.body.innerHTML = '<div class="p-4 text-center text-red-500">Aplikasi gagal dimuat. Coba muat ulang halaman.</div>';
    }
}

function setupEventListeners() {
    // Search functionality
    document.getElementById('searchProduct').addEventListener('input', (e) => loadProductsGrid(e.target.value));

    // Payment modal logic
    const cashPaidInput = document.getElementById('cashPaidInput');
    cashPaidInput.addEventListener('input', updatePaymentChange);
    
    // Auto-backup (simplified)
    setInterval(() => {
        // In a real app, this would be a more sophisticated sync/backup
        // For now, it just serves as a periodic check
        updateSyncStatus();
    }, 60000); // Check every minute
    
    window.addEventListener('online', () => { isOnline = true; updateSyncStatus(); });
    window.addEventListener('offline', () => { isOnline = false; updateSyncStatus(); });

    // Connect BT Printer Button
    document.getElementById('connectBtPrinterButton').addEventListener('click', () => {
        if (btDevice && btDevice.gatt.connected) {
            disconnectBtPrinter();
        } else {
            connectBtPrinter();
        }
    });
}

// --- UI & NAVIGATION ---
window.showPage = function(pageId) {
    if (currentPage === pageId) return;

    const pages = document.querySelectorAll('.page');
    const currentPageEl = document.getElementById(currentPage);
    const nextPageEl = document.getElementById(pageId);

    if (currentPageEl && nextPageEl) {
        // Determine animation direction
        const navItems = Array.from(document.querySelectorAll('.nav-item'));
        const currentIndex = navItems.findIndex(item => item.dataset.page === currentPage);
        const nextIndex = navItems.findIndex(item => item.dataset.page === pageId);
        
        const isExitingLeft = nextIndex > currentIndex;

        currentPageEl.style.transition = 'transform 300ms ease-in-out, opacity 300ms ease-in-out';
        nextPageEl.style.transition = 'transform 300ms ease-in-out, opacity 300ms ease-in-out';
        
        // Set initial positions for new page
        nextPageEl.classList.remove('page-exit');
        nextPageEl.style.transform = `translateX(${isExitingLeft ? '' : '-'}20px)`;
        nextPageEl.style.opacity = '0';
        
        nextPageEl.classList.add('active');

        // Animate current page out
        currentPageEl.style.transform = `translateX(${isExitingLeft ? '-' : ''}20px)`;
        currentPageEl.style.opacity = '0';

        setTimeout(() => {
            currentPageEl.classList.remove('active');
            currentPageEl.style.transform = '';
            currentPageEl.style.opacity = '';

            // Animate new page in
            nextPageEl.style.transform = 'translateX(0)';
            nextPageEl.style.opacity = '1';
        }, 50);

        setTimeout(() => {
            // Clean up styles
            currentPageEl.style.transition = '';
            nextPageEl.style.transition = '';
        }, 350);

    } else if (nextPageEl) {
        // First page load case
        pages.forEach(p => p.classList.remove('active'));
        nextPageEl.classList.add('active');
    }

    currentPage = pageId;
    
    // Update active nav item
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === pageId);
    });

    // Refresh data on page show
    if (pageId === 'dashboard') updateDashboard();
    if (pageId === 'produk') loadProductsList();
    if (pageId === 'kasir') loadProductsGrid();
}

window.handleNavClick = function(element) {
    const page = element.getAttribute('data-page');
    showPage(page);
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast show'; // Reset and show
    if (type === 'error') {
        toast.classList.add('bg-red-600');
    } else {
        toast.classList.add('bg-gray-800');
    }
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// --- MODAL FUNCTIONS ---
function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// --- Product Modals
window.showAddProductModal = () => {
    document.getElementById('productName').value = '';
    document.getElementById('productPrice').value = '';
    document.getElementById('productStock').value = '';
    document.getElementById('productBarcode').value = '';
    document.getElementById('productPurchasePrice').value = '';
    document.getElementById('productDiscount').value = '0';
    document.getElementById('imagePreview').innerHTML = `<i class="fas fa-camera text-3xl mb-2"></i><p>Tap untuk upload gambar</p>`;
    currentImageData = null;
    loadCategoriesIntoSelect('productCategory');
    showModal('addProductModal');
};
window.closeAddProductModal = () => closeModal('addProductModal');

window.showEditProductModal = async (id) => {
    const product = await dbRequest('products', 'readonly', 'get', id);
    document.getElementById('editProductId').value = product.id;
    document.getElementById('editProductName').value = product.name;
    document.getElementById('editProductBarcode').value = product.barcode || '';
    document.getElementById('editProductPurchasePrice').value = product.purchasePrice || 0;
    document.getElementById('editProductPrice').value = product.price;
    document.getElementById('editProductStock').value = product.stock;
    document.getElementById('editProductDiscount').value = product.discount || 0;
    await loadCategoriesIntoSelect('editProductCategory', product.categoryId);
    
    const preview = document.getElementById('editImagePreview');
    if (product.image) {
        preview.innerHTML = `<img src="${product.image}" class="image-preview">`;
        currentEditImageData = product.image;
    } else {
        preview.innerHTML = `<i class="fas fa-camera text-3xl mb-2"></i><p>Tap untuk ubah gambar</p>`;
        currentEditImageData = null;
    }
    showModal('editProductModal');
};
window.closeEditProductModal = () => closeModal('editProductModal');

// --- Category Modal
window.showManageCategoryModal = () => {
    loadCategoryList();
    showModal('manageCategoryModal');
};
window.closeManageCategoryModal = () => closeModal('manageCategoryModal');

// --- Fee Selection Modal
window.showFeeSelectionModal = () => {
    loadFeeSelectionList();
    showModal('feeSelectionModal');
};
window.closeFeeSelectionModal = () => closeModal('feeSelectionModal');

// --- Payment Modal
window.showPaymentModal = () => {
    if (cart.items.length === 0) {
        showToast('Keranjang kosong', 'error');
        return;
    }
    const total = calculateTotal();
    document.getElementById('paymentTotal').textContent = formatCurrency(total);
    document.getElementById('cashPaidInput').value = '';
    updatePaymentChange();
    showModal('paymentModal');
};
window.closePaymentModal = () => closeModal('paymentModal');

// --- Receipt Modal
window.showReceiptModal = (transaction, action = 'new') => {
    generateReceiptHTML(transaction, {}); // Settings will be loaded inside
    const actionButton = document.getElementById('receiptActionButton');
    if (action === 'new') {
        actionButton.textContent = 'Transaksi Baru';
        actionButton.onclick = () => {
            closeModal('receiptModal');
            startNewTransaction();
        };
    } else {
        actionButton.textContent = 'Tutup';
        actionButton.onclick = () => closeModal('receiptModal');
    }
    showModal('receiptModal');
};
window.closeReceiptModal = () => closeModal('receiptModal');

// --- Scan Modal
window.showScanModal = () => {
    showModal('scanModal');
    if (!html5QrCode) {
        html5QrCode = new Html5Qrcode("qr-reader");
    }
    html5QrCode.start(
        { facingMode: "environment" },
        {
            fps: 10,
            qrbox: { width: 250, height: 250 }
        },
        onScanSuccess,
        (errorMessage) => {} // Optional error callback
    ).catch((err) => {
        showToast("Gagal memulai kamera", 'error');
        console.error(err);
        closeScanModal();
    });
};

window.closeScanModal = () => {
    if (html5QrCode && html5QrCode.isScanning) {
        html5QrCode.stop().then(() => closeModal('scanModal')).catch(err => console.error(err));
    } else {
        closeModal('scanModal');
    }
};

window.onScanSuccess = async (decodedText) => {
    closeScanModal();
    const products = await dbRequest('products', 'readonly', 'getAll');
    const product = products.find(p => p.barcode === decodedText);
    if (product) {
        addToCart(product.id);
        showToast(`${product.name} ditambahkan`);
    } else {
        showToast('Produk tidak ditemukan', 'error');
    }
};

// --- Help Modals
window.showPrintHelpModal = () => showModal('printHelpModal');
window.closePrintHelpModal = () => closeModal('printHelpModal');

// --- Confirmation Modal
function showConfirmationModal({ title, message, confirmText, confirmClass, onConfirm }) {
    document.getElementById('confirmationTitle').textContent = title;
    document.getElementById('confirmationMessage').innerHTML = message;
    const confirmButton = document.getElementById('confirmButton');
    confirmButton.textContent = confirmText;
    confirmButton.className = `btn text-white flex-1 py-2 ${confirmClass}`;
    
    confirmCallback = onConfirm;
    
    confirmButton.onclick = () => {
        closeModal('confirmationModal');
        if (confirmCallback) confirmCallback();
    };
    document.getElementById('cancelButton').onclick = () => closeModal('confirmationModal');
    showModal('confirmationModal');
}

// --- IMAGE HANDLING ---
window.previewImage = (event) => {
    const reader = new FileReader();
    reader.onload = function(){
        currentImageData = reader.result;
        document.getElementById('imagePreview').innerHTML = `<img src="${currentImageData}" class="image-preview">`;
    };
    reader.readAsDataURL(event.target.files[0]);
};

window.previewEditImage = (event) => {
    const reader = new FileReader();
    reader.onload = function(){
        currentEditImageData = reader.result;
        document.getElementById('editImagePreview').innerHTML = `<img src="${currentEditImageData}" class="image-preview">`;
    };
    reader.readAsDataURL(event.target.files[0]);
};

window.previewStoreLogo = (event) => {
    const reader = new FileReader();
    reader.onload = function(){
        currentStoreLogoData = reader.result;
        document.getElementById('storeLogoPreview').innerHTML = `<img src="${currentStoreLogoData}" class="image-preview">`;
    };
    reader.readAsDataURL(event.target.files[0]);
};


// --- CATEGORY FUNCTIONS ---
async function loadCategories() {
    const categories = await dbRequest('categories', 'readonly', 'getAll');
    // Common select element loader
    ['productCategoryFilter', 'productCategory', 'editProductCategory'].forEach(id => {
        const select = document.getElementById(id);
        if(select) {
            const currentValue = select.value;
            select.innerHTML = id === 'productCategoryFilter' ? '<option value="all">Semua Kategori</option>' : '';
            categories.forEach(cat => {
                const option = document.createElement('option');
                option.value = cat.id;
                option.textContent = cat.name;
                select.appendChild(option);
            });
            if (currentValue) select.value = currentValue;
        }
    });
}

async function loadCategoriesIntoSelect(selectId, selectedId) {
    const select = document.getElementById(selectId);
    select.innerHTML = '';
    const categories = await dbRequest('categories', 'readonly', 'getAll');
    categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat.id;
        option.textContent = cat.name;
        if (cat.id === selectedId) {
            option.selected = true;
        }
        select.appendChild(option);
    });
}

async function loadCategoryList() {
    const categories = await dbRequest('categories', 'readonly', 'getAll');
    const list = document.getElementById('categoryList');
    list.innerHTML = categories.map(cat => `
        <div class="flex justify-between items-center p-2 bg-gray-100 rounded">
            <span>${cat.name}</span>
            <button onclick="deleteCategory(${cat.id})" class="text-red-500"><i class="fas fa-trash"></i></button>
        </div>
    `).join('');
    if (categories.length === 0) {
        list.innerHTML = '<p class="text-gray-500 text-center">Belum ada kategori</p>';
    }
}

window.addNewCategory = async () => {
    const nameInput = document.getElementById('newCategoryName');
    const name = nameInput.value.trim();
    if (!name) return;
    try {
        await dbRequest('categories', 'readwrite', 'add', { name });
        nameInput.value = '';
        await loadCategories();
        await loadCategoryList();
        showToast('Kategori ditambahkan');
    } catch (e) {
        showToast('Kategori sudah ada', 'error');
    }
};

window.deleteCategory = async (id) => {
     showConfirmationModal({
        title: 'Hapus Kategori',
        message: 'Produk dalam kategori ini tidak akan dihapus. Yakin ingin menghapus kategori ini?',
        confirmText: 'Hapus',
        confirmClass: 'bg-red-500',
        onConfirm: async () => {
            await dbRequest('categories', 'readwrite', 'delete', id);
            await loadCategories();
            await loadCategoryList();
            showToast('Kategori dihapus');
        }
    });
};

// --- PRODUCT FUNCTIONS ---
window.addProduct = async () => {
    const name = document.getElementById('productName').value;
    const price = parseFloat(document.getElementById('productPrice').value);
    const stock = parseInt(document.getElementById('productStock').value);
    const barcode = document.getElementById('productBarcode').value.trim();
    const purchasePrice = parseFloat(document.getElementById('productPurchasePrice').value) || 0;
    const categoryId = parseInt(document.getElementById('productCategory').value);
    const discount = parseFloat(document.getElementById('productDiscount').value) || 0;

    if (!name || isNaN(price) || isNaN(stock) || isNaN(categoryId)) {
        showToast('Harap isi semua kolom yang wajib diisi', 'error');
        return;
    }
    
    const newProduct = { name, price, stock, image: currentImageData, barcode, purchasePrice, categoryId, discount };
    await dbRequest('products', 'readwrite', 'add', newProduct);
    
    closeAddProductModal();
    showToast('Produk berhasil ditambahkan');
    loadProductsGrid();
    loadProductsList();
    updateDashboard();
};

window.updateProduct = async () => {
    const id = parseInt(document.getElementById('editProductId').value);
    const name = document.getElementById('editProductName').value;
    const price = parseFloat(document.getElementById('editProductPrice').value);
    const stock = parseInt(document.getElementById('editProductStock').value);
    const barcode = document.getElementById('editProductBarcode').value.trim();
    const purchasePrice = parseFloat(document.getElementById('editProductPurchasePrice').value) || 0;
    const categoryId = parseInt(document.getElementById('editProductCategory').value);
    const discount = parseFloat(document.getElementById('editProductDiscount').value) || 0;

    if (!name || isNaN(price) || isNaN(stock) || isNaN(categoryId)) {
        showToast('Harap isi semua kolom yang wajib diisi', 'error');
        return;
    }
    
    const updatedProduct = { id, name, price, stock, image: currentEditImageData, barcode, purchasePrice, categoryId, discount };
    await dbRequest('products', 'readwrite', 'put', updatedProduct);

    closeEditProductModal();
    showToast('Produk berhasil diperbarui');
    loadProductsGrid();
    loadProductsList();
    updateDashboard();
};

window.deleteProduct = (id) => {
    showConfirmationModal({
        title: 'Hapus Produk',
        message: 'Apakah Anda yakin ingin menghapus produk ini?',
        confirmText: 'Hapus',
        confirmClass: 'bg-red-500',
        onConfirm: async () => {
            await dbRequest('products', 'readwrite', 'delete', id);
            showToast('Produk dihapus');
            loadProductsList();
            loadProductsGrid();
            updateDashboard();
        }
    });
};

async function loadProductsGrid(searchTerm = '') {
    const products = await dbRequest('products', 'readonly', 'getAll');
    const grid = document.getElementById('productsGrid');
    const filteredProducts = products.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()));
    
    if (filteredProducts.length === 0) {
        grid.innerHTML = '<p class="col-span-3 text-center text-gray-500">Produk tidak ditemukan</p>';
        return;
    }
    
    grid.innerHTML = filteredProducts.map(p => `
        <div class="product-item relative" onclick="addToCart(${p.id})">
            <img src="${p.image || 'https://picsum.photos/200'}" alt="${p.name}" class="product-image">
            <p class="text-sm font-semibold truncate">${p.name}</p>
            <p class="text-xs text-gray-600">${formatCurrency(p.price)}</p>
            ${p.stock <= lowStockThreshold ? `<span class="absolute top-1 right-1 text-xs bg-yellow-400 text-white px-1.5 py-0.5 rounded-full">${p.stock}</span>` : ''}
        </div>
    `).join('');
}

window.loadProductsList = async function() {
    const categoryId = document.getElementById('productCategoryFilter').value;
    const products = await dbRequest('products', 'readonly', 'getAll');
    const categories = await dbRequest('categories', 'readonly', 'getAll');
    const categoryMap = new Map(categories.map(c => [c.id, c.name]));

    const filteredProducts = categoryId === 'all' 
        ? products 
        : products.filter(p => p.categoryId == categoryId);
    
    const list = document.getElementById('productsList');
    if (filteredProducts.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-box-open empty-state-icon"></i>
                <h3 class="empty-state-title">Belum Ada Produk</h3>
                <p class="empty-state-description">Tambahkan produk pertama Anda untuk memulai.</p>
                <button onclick="showAddProductModal()" class="empty-state-action">Tambah Produk</button>
            </div>`;
        return;
    }

    list.innerHTML = filteredProducts.map(p => `
        <div class="card flex items-center p-3 gap-4 ${p.stock <= lowStockThreshold ? 'low-stock-warning' : ''}">
            <img src="${p.image || 'https://picsum.photos/200'}" alt="${p.name}" class="product-list-image">
            <div class="flex-grow">
                <p class="font-bold truncate">${p.name}</p>
                <div class="flex items-center gap-3 text-sm text-gray-600">
                    <span>${formatCurrency(p.price)}</span>
                    <span class="text-gray-300">|</span>
                    <span>Stok: ${p.stock}</span>
                </div>
                <div class="text-xs text-gray-500 mt-1">${categoryMap.get(p.categoryId) || 'Tanpa Kategori'}</div>
            </div>
            <div class="flex gap-2">
                <button onclick="showEditProductModal(${p.id})" class="btn bg-gray-200 text-gray-700 px-3 py-1"><i class="fas fa-edit"></i></button>
                <button onclick="deleteProduct(${p.id})" class="btn bg-red-100 text-red-600 px-3 py-1"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `).join('');
}


// --- CART FUNCTIONS ---
window.addToCart = async function(productId) {
    const product = await dbRequest('products', 'readonly', 'get', productId);
    const cartItem = cart.items.find(item => item.id === productId);

    if (product.stock === 0) {
        showToast('Stok produk habis', 'error');
        return;
    }
    
    if (cartItem) {
        if (cartItem.quantity < product.stock) {
            cartItem.quantity++;
        } else {
            showToast('Stok tidak mencukupi', 'error');
        }
    } else {
        cart.items.push({ ...product, quantity: 1 });
    }
    updateCartView();
}

function updateCartView() {
    const cartItemsDiv = document.getElementById('cartItems');
    if (cart.items.length === 0) {
        cartItemsDiv.innerHTML = '<p class="text-gray-500 text-center py-4">Keranjang kosong</p>';
    } else {
        cartItemsDiv.innerHTML = cart.items.map(item => `
            <div class="cart-item flex items-center justify-between">
                <div>
                    <p class="font-semibold truncate">${item.name}</p>
                    <p class="text-sm text-gray-500">${formatCurrency(item.price)}</p>
                </div>
                <div class="flex items-center gap-3">
                    <button onclick="updateCartItem(${item.id}, -1)" class="btn bg-gray-200 w-7 h-7">-</button>
                    <span>${item.quantity}</span>
                    <button onclick="updateCartItem(${item.id}, 1)" class="btn bg-gray-200 w-7 h-7">+</button>
                </div>
            </div>
        `).join('');
    }
    
    updateCartTotals();
}

function updateCartTotals() {
    const subtotal = cart.items.reduce((acc, item) => acc + (item.price * item.quantity), 0);
    const total = calculateTotal();
    
    document.getElementById('cartSubtotal').textContent = formatCurrency(subtotal);
    document.getElementById('cartTotal').textContent = formatCurrency(total);

    const feesContainer = document.getElementById('cartFees');
    if(cart.fees.length > 0) {
        feesContainer.innerHTML = cart.fees.map(fee => {
            const feeAmount = fee.type === 'percentage' ? (subtotal * fee.value / 100) : fee.value;
            return `<div class="flex justify-between"><span>${fee.name}:</span><span>${formatCurrency(feeAmount)}</span></div>`;
        }).join('');
    } else {
        feesContainer.innerHTML = '';
    }
}

function calculateTotal() {
    const subtotal = cart.items.reduce((acc, item) => acc + (item.price * item.quantity), 0);
    const feeAmount = cart.fees.reduce((acc, fee) => {
        return acc + (fee.type === 'percentage' ? (subtotal * fee.value / 100) : fee.value);
    }, 0);
    return subtotal + feeAmount;
}


window.updateCartItem = (productId, change) => {
    const cartItem = cart.items.find(item => item.id === productId);
    if (!cartItem) return;
    
    const newQuantity = cartItem.quantity + change;
    
    if (newQuantity <= 0) {
        cart.items = cart.items.filter(item => item.id !== productId);
    } else {
        if (newQuantity > cartItem.stock) {
            showToast('Stok tidak mencukupi', 'error');
            return;
        }
        cartItem.quantity = newQuantity;
    }
    updateCartView();
};

window.clearCart = () => {
    if (cart.items.length === 0) return;
    showConfirmationModal({
        title: 'Kosongkan Keranjang',
        message: 'Anda yakin ingin mengosongkan keranjang?',
        confirmText: 'Kosongkan',
        confirmClass: 'bg-red-500',
        onConfirm: () => {
            cart.items = [];
            applyDefaultFees();
            updateCartView();
            showToast('Keranjang dikosongkan');
        }
    });
};

function startNewTransaction() {
    cart.items = [];
    applyDefaultFees();
    updateCartView();
    // Don't switch page, allow user to stay on dashboard or wherever they are
    if(currentPage === 'receipt') { // an edge case if they are on a reprinted receipt
        showPage('kasir');
    }
}

// --- FEES FUNCTIONS ---
async function loadFees() {
    const fees = await dbRequest('fees', 'readonly', 'getAll');
    const list = document.getElementById('feesList');
    list.innerHTML = fees.map(f => `
        <div class="flex justify-between items-center p-2 bg-gray-100 rounded">
            <div>
                <span class="font-semibold">${f.name}</span>
                <span class="text-sm text-gray-600">(${f.type === 'percentage' ? `${f.value}%` : formatCurrency(f.value)})</span>
                ${f.isDefault ? '<span class="text-xs bg-blue-500 text-white px-2 py-0.5 rounded-full ml-2">Default</span>' : ''}
            </div>
            <button onclick="deleteFee(${f.id})" class="text-red-500"><i class="fas fa-trash"></i></button>
        </div>
    `).join('');
    if (fees.length === 0) {
        list.innerHTML = '<p class="text-gray-500 text-center">Belum ada biaya</p>';
    }
}

window.addFee = async () => {
    const name = document.getElementById('feeName').value.trim();
    const type = document.getElementById('feeType').value;
    const value = parseFloat(document.getElementById('feeValue').value);
    const isDefault = document.getElementById('feeIsDefault').checked;

    if (!name || isNaN(value)) {
        showToast('Nama dan nilai biaya harus diisi', 'error');
        return;
    }

    try {
        await dbRequest('fees', 'readwrite', 'add', { name, type, value, isDefault });
        document.getElementById('feeName').value = '';
        document.getElementById('feeValue').value = '';
        document.getElementById('feeIsDefault').checked = false;
        loadFees();
        showToast('Biaya ditambahkan');
    } catch (e) {
        showToast('Nama biaya sudah ada', 'error');
    }
};

window.deleteFee = async (id) => {
    await dbRequest('fees', 'readwrite', 'delete', id);
    loadFees();
    showToast('Biaya dihapus');
};

async function loadFeeSelectionList() {
    const allFees = await dbRequest('fees', 'readonly', 'getAll');
    const list = document.getElementById('feeSelectionList');
    list.innerHTML = allFees.map(fee => `
        <div class="flex justify-between items-center">
            <label for="fee-select-${fee.id}" class="cursor-pointer">
                ${fee.name} (${fee.type === 'percentage' ? `${fee.value}%` : formatCurrency(fee.value)})
            </label>
            <input type="checkbox" id="fee-select-${fee.id}" data-fee-id="${fee.id}" 
                   class="h-5 w-5 rounded text-blue-600 focus:ring-blue-500 border-gray-300"
                   ${cart.fees.some(cf => cf.id === fee.id) ? 'checked' : ''}>
        </div>
    `).join('');
}

window.applySelectedFees = async () => {
    const allFees = await dbRequest('fees', 'readonly', 'getAll');
    const selectedFeeIds = Array.from(document.querySelectorAll('#feeSelectionList input:checked')).map(input => parseInt(input.dataset.feeId));
    
    cart.fees = allFees.filter(fee => selectedFeeIds.includes(fee.id));
    updateCartTotals();
    closeFeeSelectionModal();
    showToast('Pajak & biaya diperbarui');
};

async function applyDefaultFees() {
    const allFees = await dbRequest('fees', 'readonly', 'getAll');
    cart.fees = allFees.filter(fee => fee.isDefault);
    updateCartTotals();
}


// --- TRANSACTION & PAYMENT ---
window.handleQuickCash = (amount) => {
    const input = document.getElementById('cashPaidInput');
    input.value = amount;
    updatePaymentChange();
};

function updatePaymentChange() {
    const total = calculateTotal();
    const cashPaid = parseFloat(document.getElementById('cashPaidInput').value) || 0;
    const change = cashPaid - total;
    
    const changeEl = document.getElementById('paymentChange');
    const changeLabelEl = document.getElementById('paymentChangeLabel');
    const completeButton = document.getElementById('completeTransactionButton');
    
    if (change >= 0) {
        changeEl.textContent = formatCurrency(change);
        changeEl.classList.remove('text-red-500');
        changeEl.classList.add('text-green-500');
        changeLabelEl.textContent = 'Kembalian:';
        completeButton.disabled = false;
    } else {
        changeEl.textContent = formatCurrency(Math.abs(change));
        changeEl.classList.remove('text-green-500');
        changeEl.classList.add('text-red-500');
        changeLabelEl.textContent = 'Kurang:';
        completeButton.disabled = true;
    }
}

window.completeTransaction = async () => {
    const completeButton = document.getElementById('completeTransactionButton');
    const spinner = completeButton.querySelector('.payment-button-spinner');
    const text = completeButton.querySelector('.payment-button-text');
    
    spinner.classList.remove('hidden');
    text.classList.add('hidden');
    completeButton.disabled = true;

    try {
        const total = calculateTotal();
        const subtotal = cart.items.reduce((acc, item) => acc + (item.price * item.quantity), 0);
        const cashPaid = parseFloat(document.getElementById('cashPaidInput').value);
        const change = cashPaid - total;

        const newTransaction = {
            date: new Date().toISOString(),
            items: cart.items,
            subtotal,
            total,
            fees: cart.fees,
            cashPaid,
            change,
            receiptNumber: `TRX-${Date.now()}`
        };

        // --- ATOMIC TRANSACTION ---
        const tx = db.transaction(['transactions', 'products'], 'readwrite');
        const transactionStore = tx.objectStore('transactions');
        const productStore = tx.objectStore('products');

        // 1. Add the transaction record and get its ID
        const addRequest = transactionStore.add(newTransaction);
        
        // 2. Create promises to update stock for each item
        const updatePromises = cart.items.map(item => {
            return new Promise((resolve, reject) => {
                const getRequest = productStore.get(item.id);
                getRequest.onsuccess = () => {
                    const product = getRequest.result;
                    if (product) {
                        product.stock -= item.quantity;
                        const putRequest = productStore.put(product);
                        putRequest.onsuccess = resolve;
                        putRequest.onerror = reject;
                    } else {
                        reject(new Error(`Produk dengan id ${item.id} tidak ditemukan.`));
                    }
                };
                getRequest.onerror = reject;
            });
        });

        // 3. Wait for all updates to be queued
        await Promise.all(updatePromises);
        
        // 4. Wait for the transaction to complete
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        
        const transactionId = addRequest.result;

        // --- END ATOMIC TRANSACTION ---

        closePaymentModal();

        const autoPrint = (await dbRequest('settings', 'readonly', 'get', 'autoPrintReceipt'))?.value ?? false;
        
        const savedTransaction = await dbRequest('transactions', 'readonly', 'get', transactionId);

        if (autoPrint) {
            await printReceipt(savedTransaction);
            startNewTransaction();
        } else {
            showReceiptModal(savedTransaction, 'new');
        }
        
        updateDashboard();
        loadProductsGrid();

    } catch (error) {
        console.error("Transaksi gagal:", error);
        showToast(`Transaksi gagal: ${error.message}`, 'error');
    } finally {
        spinner.classList.add('hidden');
        text.classList.remove('hidden');
        if (!document.getElementById('paymentModal').classList.contains('hidden')) {
             completeButton.disabled = false;
        }
    }
};


// --- RECEIPT & PRINTING ---
async function generateReceiptHTML(transaction, settings) {
    if (!settings.storeName) { // settings might be empty for reprint
        settings = (await dbRequest('settings', 'readonly', 'getAll')).reduce((acc, s) => { acc[s.key] = s.value; return acc; }, {});
    }

    const {
        storeName = 'Toko Anda',
        storeAddress = '',
        storeFeedbackPhone = '',
        storeLogo,
        storeFooterText = 'Terima Kasih!',
    } = settings;

    const subtotal = transaction.items.reduce((sum, item) => sum + item.price * item.quantity, 0);

    let itemsHtml = transaction.items.map(item => `
        <tr>
            <td colspan="3">${item.name}</td>
        </tr>
        <tr>
            <td class="text-left">${item.quantity} x ${formatCurrency(item.price, false)}</td>
            <td></td>
            <td class="text-right">${formatCurrency(item.price * item.quantity, false)}</td>
        </tr>
    `).join('');

    let feesHtml = '';
    if (transaction.fees && transaction.fees.length > 0) {
        feesHtml = transaction.fees.map(fee => {
            const amount = fee.type === 'percentage' ? (subtotal * fee.value / 100) : fee.value;
            return `<tr><td>${fee.name}</td><td></td><td class="text-right">${formatCurrency(amount, false)}</td></tr>`;
        }).join('');
    }

    const receiptContent = `
        <div class="receipt-header text-center p-2">
            ${storeLogo ? `<div id="receiptLogoContainer" class="mb-2"><img src="${storeLogo}" alt="logo" class="mx-auto max-h-20"></div>` : ''}
            <h2 class="text-lg font-bold">${storeName}</h2>
            <p class="text-xs">${storeAddress}</p>
            ${storeFeedbackPhone ? `<p class="text-xs">Kritik/Saran: ${storeFeedbackPhone}</p>` : ''}
        </div>
        <div class="receipt-divider">--------------------------------</div>
        <div class="p-2 text-xs">
            <div class="flex justify-between">
                <span>${new Date(transaction.date).toLocaleDateString('id-ID')}</span>
                <span>${new Date(transaction.date).toLocaleTimeString('id-ID')}</span>
            </div>
            <div>No: ${transaction.receiptNumber}</div>
        </div>
        <div class="receipt-divider">--------------------------------</div>
        <div class="p-2 text-xs">
            <table class="w-full">
                <tbody>
                    ${itemsHtml}
                </tbody>
            </table>
        </div>
        <div class="receipt-divider">--------------------------------</div>
        <div class="p-2 text-xs">
            <table class="w-full">
                <tbody>
                    <tr><td>Subtotal</td><td></td><td class="text-right">${formatCurrency(subtotal, false)}</td></tr>
                    ${feesHtml}
                    <tr class="font-bold"><td>Total</td><td></td><td class="text-right">${formatCurrency(transaction.total, false)}</td></tr>
                    <tr><td>Tunai</td><td></td><td class="text-right">${formatCurrency(transaction.cashPaid, false)}</td></tr>
                    <tr><td>Kembali</td><td></td><td class="text-right">${formatCurrency(transaction.change, false)}</td></tr>
                </tbody>
            </table>
        </div>
        <div class="receipt-divider">--------------------------------</div>
        <div class="text-center p-2 text-xs">
            <p>${storeFooterText}</p>
        </div>
    `;
    
    document.getElementById('receiptContent').innerHTML = receiptContent;
}

window.printReceipt = async (transactionOrId) => {
    let transaction = transactionOrId;
    if (typeof transactionOrId === 'number') {
        transaction = await dbRequest('transactions', 'readonly', 'get', transactionOrId);
        showReceiptModal(transaction, 'reprint');
    }
    
    if (!transaction) return;
    
    if (btDevice && btDevice.gatt.connected) {
        showToast('Mencetak via Bluetooth...');
        try {
            const escPosData = await generateEscPosReceipt(transaction);
            const success = await printViaBluetooth(escPosData);
            if (success) {
                showToast('Struk dikirim ke printer Bluetooth');
                return;
            } else {
                 showToast('Gagal cetak Bluetooth, coba cetak browser', 'error');
            }
        } catch(e) {
            console.error(e);
            showToast('Gagal siapkan data cetak', 'error');
        }
    }

    // Fallback to browser print
    await generateReceiptHTML(transaction, {});
    const paperSize = (await dbRequest('settings', 'readonly', 'get', 'printerPaperSize'))?.value || '80mm';
    const styleOverrides = document.getElementById('print-style-overrides');
    
    let widthStyle = "width: 72mm;"; // Default for 80mm
    if (paperSize === '58mm') {
        widthStyle = "width: 48mm; font-size: 10pt;";
    }
    
    styleOverrides.innerHTML = `
        @media print {
            #receiptContent {
                ${widthStyle}
            }
             #receiptLogoContainer {
                display: block !important;
            }
        }
    `;

    setTimeout(() => window.print(), 100);
};

window.testPrint = async () => {
    const testTransaction = {
        date: new Date().toISOString(),
        items: [{ name: 'PRODUK CONTOH', quantity: 1, price: 10000 }],
        subtotal: 10000,
        total: 10000,
        fees: [],
        cashPaid: 10000,
        change: 0,
        receiptNumber: 'TES-12345'
    };
    await printReceipt(testTransaction);
};


// --- BLUETOOTH PRINTING ---
function initBluetooth() {
    const btSection = document.getElementById('bluetoothSection');
    if ('bluetooth' in navigator) {
        navigator.bluetooth.getAvailability().then(isAvailable => {
            if (isAvailable) {
                btSection.style.display = 'block';
            } else {
                console.warn('Web Bluetooth available but not enabled.');
            }
        }).catch(() => {
            console.warn('Could not check Bluetooth availability.');
        });
    } else {
        console.warn('Web Bluetooth API not supported.');
    }
}

async function connectBtPrinter() {
    updateBtStatus(null, 'connecting'); // Set connecting state
    try {
        const isAvailable = await navigator.bluetooth.getAvailability();
        if (!isAvailable) {
            throw new Error('Bluetooth is not available on this device.');
        }

        btDevice = await navigator.bluetooth.requestDevice({
             acceptAllDevices: true,
             optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb'] // Generic Serial Port Service
        });

        btDevice.addEventListener('gattserverdisconnected', onBtDisconnected);
        const server = await btDevice.gatt.connect();
        const service = await server.getPrimaryService('000018f0-0000-1000-8000-00805f9b34fb');
        btCharacteristic = await service.getCharacteristic('00002af1-0000-1000-8000-00805f9b34fb');

        updateBtStatus(true);
        showToast('Printer Bluetooth terhubung');

    } catch (error) {
        console.error('Koneksi Bluetooth gagal:', error);
        let message = 'Koneksi Bluetooth gagal.';
        if (error.name === 'NotFoundError') {
            message = 'Tidak ada printer dipilih.';
        } else if (error.message.includes('globally disabled')) {
            message = 'Web Bluetooth tidak diaktifkan oleh browser/OS.';
        } else if (error.message.includes('cancelled')) {
            message = 'Pemilihan perangkat dibatalkan.';
        }
        showToast(message, 'error');
        disconnectBtPrinter();
    }
}

function disconnectBtPrinter() {
    if (btDevice && btDevice.gatt.connected) {
        btDevice.gatt.disconnect();
    }
    if(btDevice) {
        btDevice.removeEventListener('gattserverdisconnected', onBtDisconnected);
    }
    btDevice = null;
    btCharacteristic = null;
    updateBtStatus(false);
}

function onBtDisconnected() {
    showToast('Koneksi printer Bluetooth terputus', 'error');
    disconnectBtPrinter();
}

function updateBtStatus(isConnected, state) {
    const statusEl = document.getElementById('btStatus');
    const buttonEl = document.getElementById('connectBtPrinterButton');
    const buttonTextEl = document.getElementById('connectBtPrinterButtonText');

    if (state === 'connecting') {
        statusEl.textContent = 'Menghubungkan...';
        statusEl.className = 'font-semibold text-sm text-yellow-500';
        buttonTextEl.textContent = 'Menghubungkan...';
        buttonEl.disabled = true;
        return;
    }

    buttonEl.disabled = false;
    if (isConnected) {
        statusEl.textContent = 'Terhubung';
        statusEl.className = 'font-semibold text-sm text-green-500';
        buttonTextEl.textContent = 'Putuskan Printer';
        buttonEl.classList.remove('bg-indigo-500');
        buttonEl.classList.add('bg-red-500');
    } else {
        statusEl.textContent = 'Tidak Terhubung';
        statusEl.className = 'font-semibold text-sm text-gray-500';
        buttonTextEl.textContent = 'Hubungkan Printer';
        buttonEl.classList.remove('bg-red-500');
        buttonEl.classList.add('bg-indigo-500');
    }
}

async function printViaBluetooth(data) {
    if (!btCharacteristic) {
        showToast('Printer Bluetooth tidak terhubung.', 'error');
        return false;
    }
    try {
        const maxChunkSize = 100; // Common value for BLE
        for (let i = 0; i < data.length; i += maxChunkSize) {
            const chunk = data.slice(i, i + maxChunkSize);
            await btCharacteristic.writeValueWithoutResponse(chunk);
        }
        return true;
    } catch (error) {
        console.error('Gagal mencetak via Bluetooth:', error);
        showToast('Gagal mencetak. Printer mungkin mati.', 'error');
        return false;
    }
}

// Helper to load a base64 image
function loadImage(base64) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = (err) => reject(err);
        img.src = base64;
    });
}

async function generateEscPosReceipt(transaction) {
    const settings = (await dbRequest('settings', 'readonly', 'getAll')).reduce((acc, s) => ({ ...acc, [s.key]: s.value }), {});
    const encoder = new EscposEncoder();

    encoder.initialize();
    encoder.align('center');

    // Print Logo
    if (settings.storeLogo) {
        try {
            const logoImage = await loadImage(settings.storeLogo);
            encoder.image(logoImage, 384, 384, 'atkinson');
            encoder.newline();
        } catch (e) {
            console.error("Gagal memuat logo untuk dicetak:", e);
        }
    }

    if (settings.storeName) {
        encoder.bold(true).text(settings.storeName).bold(false).newline();
    }
    if (settings.storeAddress) {
        encoder.text(settings.storeAddress).newline();
    }
    if (settings.storeFeedbackPhone) {
        encoder.text(`Kritik/Saran: ${settings.storeFeedbackPhone}`).newline();
    }
    encoder.rule().newline();

    encoder.align('left');
    encoder.table(
        [
            { width: 16, align: 'left' },
            { width: 16, align: 'right' },
        ],
        [
            [new Date(transaction.date).toLocaleDateString('id-ID'), new Date(transaction.date).toLocaleTimeString('id-ID')],
            [`No: ${transaction.receiptNumber}`, ''],
        ]
    );
    encoder.rule().newline();

    // Items
    transaction.items.forEach(item => {
        encoder.text(item.name).newline();
        encoder.table(
            [{ width: 22, align: 'left' }, { width: 10, align: 'right' }],
            [[`  ${item.quantity} x ${formatCurrency(item.price, false)}`, formatCurrency(item.price * item.quantity, false)]]
        );
    });
    encoder.rule().newline();

    // Totals
    const subtotal = transaction.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    encoder.align('right');
    encoder.table(
        [{ width: 22, align: 'left' }, { width: 10, align: 'right' }],
        [['Subtotal', formatCurrency(subtotal, false)]]
    );

    if (transaction.fees) {
        transaction.fees.forEach(fee => {
            const amount = fee.type === 'percentage' ? (subtotal * fee.value / 100) : fee.value;
            encoder.table(
                [{ width: 22, align: 'left' }, { width: 10, align: 'right' }],
                [[fee.name, formatCurrency(amount, false)]]
            );
        });
    }

    encoder.bold(true);
    encoder.table(
        [{ width: 22, align: 'left' }, { width: 10, align: 'right' }],
        [['Total', formatCurrency(transaction.total, false)]]
    );
    encoder.bold(false);

    encoder.table(
        [{ width: 22, align: 'left' }, { width: 10, align: 'right' }],
        [
            ['Tunai', formatCurrency(transaction.cashPaid, false)],
            ['Kembali', formatCurrency(transaction.change, false)],
        ]
    );
    encoder.rule().newline();

    // Footer
    encoder.align('center');
    if (settings.storeFooterText) {
        encoder.text(settings.storeFooterText).newline();
    }
    
    encoder.newline().newline().cut();
    return encoder.encode();
}

// --- DASHBOARD ---
async function updateDashboard() {
    const transactions = await dbRequest('transactions', 'readonly', 'getAll');
    const products = await dbRequest('products', 'readonly', 'getAll');
    
    const today = new Date().toISOString().split('T')[0];
    const thisMonth = new Date().toISOString().slice(0, 7);

    const todayTransactions = transactions.filter(t => t.date.startsWith(today));
    const monthTransactions = transactions.filter(t => t.date.startsWith(thisMonth));

    const todaySales = todayTransactions.reduce((sum, t) => sum + t.total, 0);
    const monthSales = monthTransactions.reduce((sum, t) => sum + t.total, 0);
    
    document.getElementById('todaySales').textContent = formatCurrency(todaySales);
    document.getElementById('todayTransactions').textContent = todayTransactions.length;
    document.getElementById('totalProducts').textContent = products.length;
    document.getElementById('lowStockProducts').textContent = products.filter(p => p.stock <= lowStockThreshold).length;
    document.getElementById('monthSales').textContent = formatCurrency(monthSales);

    // Recent transactions
    const recentDiv = document.getElementById('recentTransactions');
    const recent = transactions.slice(-5).reverse();
    if (recent.length === 0) {
        recentDiv.innerHTML = '<p class="text-gray-500 text-center py-4">Belum ada transaksi</p>';
    } else {
        recentDiv.innerHTML = recent.map(t => `
            <div class="flex justify-between items-center p-2 rounded hover:bg-gray-100 clickable" onclick="printReceipt(${t.id})">
                <div>
                    <p class="font-semibold">${t.receiptNumber}</p>
                    <p class="text-xs text-gray-500">${new Date(t.date).toLocaleString('id-ID')}</p>
                </div>
                <div class="text-right">
                     <p class="font-semibold">${formatCurrency(t.total)}</p>
                     <p class="text-xs text-gray-500">${t.items.length} item</p>
                </div>
            </div>
        `).join('');
    }
    
    // Update store name display
    const settings = await dbRequest('settings', 'readonly', 'getAll');
    const storeName = settings.find(s => s.key === 'storeName')?.value;
    const storeAddress = settings.find(s => s.key === 'storeAddress')?.value;
    if (storeName) {
        document.getElementById('dashboardStoreName').textContent = storeName;
        document.getElementById('dashboardStoreAddress').textContent = storeAddress || 'Alamat belum diatur';
    } else {
        document.getElementById('dashboardStoreName').textContent = 'Dasbor';
        document.getElementById('dashboardStoreAddress').textContent = 'Pengaturan toko belum diisi';
    }
}


// --- SETTINGS ---
window.saveStoreSettings = async () => {
    try {
        // 1. Prepare all data *before* the transaction
        let logoToSave = currentStoreLogoData;
        
        // If no new logo was explicitly uploaded (it's still pointing to the loaded data),
        // we check if a file was selected. If not, we fetch the old logo to keep it.
        // `currentStoreLogoData` is only updated on file selection.
        // A simple check is to see if it's different from what was loaded.
        // A better approach is to use a separate flag, but this is complex.
        // The most robust way: always fetch existing if `currentStoreLogoData` hasn't been re-assigned by the file picker.
        // Let's assume `null` means "no change from loaded value".
        
        const settingsToSave = [
            { key: 'storeName', value: document.getElementById('storeName').value },
            { key: 'storeAddress', value: document.getElementById('storeAddress').value },
            { key: 'storeFeedbackPhone', value: document.getElementById('storeFeedbackPhone').value },
            { key: 'storeFooterText', value: document.getElementById('storeFooterText').value },
            { key: 'autoPrintReceipt', value: document.getElementById('autoPrintReceipt').checked },
            { key: 'lowStockThreshold', value: parseInt(document.getElementById('lowStockThreshold').value) || 5 },
            { key: 'printerPaperSize', value: document.getElementById('printerPaperSize').value },
        ];
        
        // Handle logo separately to avoid async calls inside the write transaction
        const existingLogo = await dbRequest('settings', 'readonly', 'get', 'storeLogo');
        // `currentStoreLogoData` holds the value from `loadStoreSettings` or from the file picker
        // If it's the same as existing, no change. If it's new, it will be different.
        settingsToSave.push({ key: 'storeLogo', value: currentStoreLogoData });

        // 2. Perform a single atomic transaction
        const tx = db.transaction('settings', 'readwrite');
        const store = tx.objectStore('settings');
        settingsToSave.forEach(setting => {
            store.put(setting);
        });

        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = reject;
        });

        await loadStoreSettings();
        updateDashboard();
        showToast('Pengaturan disimpan');

    } catch (error) {
        console.error('Gagal menyimpan pengaturan:', error);
        showToast('Gagal menyimpan pengaturan', 'error');
    }
};

async function loadStoreSettings() {
    const settings = await dbRequest('settings', 'readonly', 'getAll');
    const settingsMap = new Map(settings.map(s => [s.key, s.value]));
    
    document.getElementById('storeName').value = settingsMap.get('storeName') || '';
    document.getElementById('storeAddress').value = settingsMap.get('storeAddress') || '';
    document.getElementById('storeFeedbackPhone').value = settingsMap.get('storeFeedbackPhone') || '';
    document.getElementById('storeFooterText').value = settingsMap.get('storeFooterText') || '';
    document.getElementById('autoPrintReceipt').checked = settingsMap.get('autoPrintReceipt') || false;
    document.getElementById('lowStockThreshold').value = settingsMap.get('lowStockThreshold') || 5;
    document.getElementById('printerPaperSize').value = settingsMap.get('printerPaperSize') || '80mm';
    
    lowStockThreshold = settingsMap.get('lowStockThreshold') || 5;
    currentStoreLogoData = settingsMap.get('storeLogo') || null;

    if (currentStoreLogoData) {
        document.getElementById('storeLogoPreview').innerHTML = `<img src="${currentStoreLogoData}" class="image-preview">`;
    } else {
         document.getElementById('storeLogoPreview').innerHTML = `
            <div class="upload-placeholder">
                <i class="fas fa-image text-3xl mb-2"></i>
                <p>Tap untuk upload logo</p>
            </div>`;
    }
}


// --- REPORTING ---
window.generateReport = async () => {
    const from = new Date(document.getElementById('dateFrom').value);
    const to = new Date(document.getElementById('dateTo').value);
    to.setHours(23, 59, 59, 999); // Include entire end day

    if (isNaN(from) || isNaN(to)) {
        showToast('Pilih rentang tanggal yang valid', 'error');
        return;
    }
    
    const allTransactions = await dbRequest('transactions', 'readonly', 'getAll');
    currentReportData = allTransactions.filter(t => {
        const tDate = new Date(t.date);
        return tDate >= from && tDate <= to;
    });
    
    if (currentReportData.length === 0) {
        showToast('Tidak ada data untuk rentang tanggal ini', 'error');
        document.getElementById('reportSummary').style.display = 'none';
        document.getElementById('reportDetails').style.display = 'none';
        document.getElementById('topSellingProductsCard').style.display = 'none';
        return;
    }
    
    // Summary
    const totalSales = currentReportData.reduce((sum, t) => sum + t.total, 0);
    const totalTransactions = currentReportData.length;
    const totalTaxAndFees = currentReportData.reduce((sum, t) => sum + (t.total - t.subtotal), 0);
    
    document.getElementById('reportTotalSales').textContent = formatCurrency(totalSales);
    document.getElementById('reportTotalTransactions').textContent = totalTransactions;
    document.getElementById('reportTotalTax').textContent = formatCurrency(totalTaxAndFees); // This is a simplification
    document.getElementById('reportTotalFees').textContent = formatCurrency(0); // This is a simplification
    document.getElementById('reportAverage').textContent = formatCurrency(totalSales / totalTransactions);

    // Top selling products
    const productSales = {};
    currentReportData.forEach(t => {
        t.items.forEach(item => {
            if (!productSales[item.name]) {
                productSales[item.name] = { quantity: 0, sales: 0 };
            }
            productSales[item.name].quantity += item.quantity;
            productSales[item.name].sales += item.quantity * item.price;
        });
    });
    
    const topProducts = Object.entries(productSales)
        .sort(([, a], [, b]) => b.quantity - a.quantity)
        .slice(0, 5);

    document.getElementById('topSellingProductsList').innerHTML = topProducts.map(([name, data]) => `
        <div class="flex justify-between p-1">
            <span>${name}</span>
            <span class="font-semibold">${data.quantity} terjual</span>
        </div>
    `).join('');

    // Details
    document.getElementById('reportTransactions').innerHTML = currentReportData.map(t => `
        <div class="p-2 border-b">
            <div class="flex justify-between">
                <span class="font-semibold">${t.receiptNumber}</span>
                <span class="font-semibold">${formatCurrency(t.total)}</span>
            </div>
            <div class="text-xs text-gray-500">${new Date(t.date).toLocaleString('id-ID')}</div>
        </div>
    `).join('');
    
    document.getElementById('reportSummary').style.display = 'block';
    document.getElementById('reportDetails').style.display = 'block';
    document.getElementById('topSellingProductsCard').style.display = 'block';
};

window.exportReportToCSV = () => {
    if (currentReportData.length === 0) {
        showToast('Tidak ada data untuk diekspor', 'error');
        return;
    }
    
    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "No Struk,Tanggal,Jam,Item,Qty,Harga,Total Item,Subtotal Transaksi,Pajak & Biaya,Total Transaksi\n";
    
    currentReportData.forEach(t => {
        t.items.forEach(item => {
            const date = new Date(t.date);
            const feeTotal = t.total - t.subtotal;
            let row = [
                t.receiptNumber,
                date.toLocaleDateString('id-ID'),
                date.toLocaleTimeString('id-ID'),
                `"${item.name}"`,
                item.quantity,
                item.price,
                item.quantity * item.price,
                t.subtotal,
                feeTotal,
                t.total,
            ].join(',');
            csvContent += row + "\n";
        });
    });
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `laporan_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};


// --- DATA MANAGEMENT ---
window.exportData = async () => {
    const data = {};
    for (const storeName of db.objectStoreNames) {
        data[storeName] = await dbRequest(storeName, 'readonly', 'getAll');
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pos_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Data diekspor');
};

window.importData = () => {
    document.getElementById('importFile').click();
};

window.handleImport = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            showConfirmationModal({
                title: 'Import Data',
                message: 'Ini akan menghapus semua data saat ini dan menggantinya dengan data dari file. Lanjutkan?',
                confirmText: 'Import',
                confirmClass: 'bg-orange-500',
                onConfirm: async () => {
                    const tx = db.transaction(db.objectStoreNames, 'readwrite');
                    for (const storeName of db.objectStoreNames) {
                        tx.objectStore(storeName).clear();
                        if (data[storeName]) {
                            for (const record of data[storeName]) {
                                tx.objectStore(storeName).put(record);
                            }
                        }
                    }
                    await new Promise(resolve => tx.oncomplete = resolve);
                    showToast('Data berhasil diimpor. Aplikasi akan dimuat ulang.');
                    setTimeout(() => window.location.reload(), 2000);
                }
            });
        } catch (error) {
            showToast('File import tidak valid', 'error');
        }
    };
    reader.readAsText(file);
};

window.clearAllData = () => {
    showConfirmationModal({
        title: 'Hapus Semua Data',
        message: '<strong>PERINGATAN:</strong> Tindakan ini tidak dapat diurungkan. Semua produk, transaksi, dan pengaturan akan dihapus secara permanen. Ekspor data Anda terlebih dahulu jika perlu.',
        confirmText: 'Hapus Semua',
        confirmClass: 'bg-red-600',
        onConfirm: async () => {
            const tx = db.transaction(db.objectStoreNames, 'readwrite');
            for (const storeName of db.objectStoreNames) {
                tx.objectStore(storeName).clear();
            }
            await new Promise(resolve => tx.oncomplete = resolve);
            showToast('Semua data telah dihapus. Aplikasi akan dimuat ulang.');
            setTimeout(() => window.location.reload(), 2000);
        }
    });
};


// --- SYNC ---
window.syncWithServer = async (manual = false) => {
    if (isSyncing) return;
    isSyncing = true;
    updateSyncStatus();
    
    // Dummy sync process
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    isSyncing = false;
    updateSyncStatus(new Date());
    if (manual) showToast('Sinkronisasi selesai');
};

async function updateSyncStatus(lastSyncDate) {
    const syncIcon = document.getElementById('syncIcon');
    const syncText = document.getElementById('syncText');
    
    if (isSyncing) {
        syncIcon.classList.add('fa-spin');
        syncText.textContent = 'Menyinkronkan...';
        return;
    }
    
    syncIcon.classList.remove('fa-spin');
    
    if (!isOnline) {
        syncText.textContent = 'Offline';
        return;
    }
    
    if (lastSyncDate) {
        await dbRequest('settings', 'readwrite', 'put', { key: 'lastSync', value: lastSyncDate });
    }
    
    const lastSync = (await dbRequest('settings', 'readonly', 'get', 'lastSync'))?.value;
    if (lastSync) {
        syncText.textContent = `Sync: ${new Date(lastSync).toLocaleTimeString('id-ID')}`;
    } else {
        syncText.textContent = 'Belum sinkron';
    }
}


// --- UTILITY FUNCTIONS ---
function formatCurrency(amount, prefix = true) {
    const formatter = new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    });
    let formatted = formatter.format(amount);
    return prefix ? formatted : formatted.replace('Rp', '').trim();
}