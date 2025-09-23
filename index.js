/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

// --- GLOBAL STATE & CONFIG ---
let db;
let cart = [];
let currentImageData = null;
let currentEditImageData = null;
let currentStoreLogoData = null;
let currentPage = 'dashboard';
let confirmCallback = null;
let codeReader;
let videoStream;
let currentReportData = [];
let lowStockThreshold = 5; // Default value


// --- DATABASE FUNCTIONS ---
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('POS_DB', 5); 

        request.onerror = function() {
            showToast('Gagal menginisialisasi database');
            reject();
        };
        
        request.onsuccess = function(event) {
            db = event.target.result;
            resolve();
        };
        
        request.onupgradeneeded = async function(event) {
            db = event.target.result;
            const transaction = event.target.transaction;
            
            if (event.oldVersion < 2) {
                if (!db.objectStoreNames.contains('products')) {
                    const productStore = db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
                    productStore.createIndex('name', 'name', { unique: false });
                }
                if (!db.objectStoreNames.contains('transactions')) {
                    const transactionStore = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
                    transactionStore.createIndex('date', 'date', { unique: false });
                }
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
            }
            
            if (event.oldVersion < 3) {
                if (db.objectStoreNames.contains('products')) {
                    const productStore = transaction.objectStore('products');
                    if (!productStore.indexNames.contains('barcode')) {
                        productStore.createIndex('barcode', 'barcode', { unique: true });
                    }
                }
            }

            if (event.oldVersion < 4) {
                if (!db.objectStoreNames.contains('auto_backup')) {
                    db.createObjectStore('auto_backup', { keyPath: 'key' });
                }
            }
            
            if (event.oldVersion < 5) {
                if (!db.objectStoreNames.contains('categories')) {
                    const categoryStore = db.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
                    categoryStore.createIndex('name', 'name', { unique: true });
                }
                 // Migration logic: Populate categories from existing products
                const productStore = transaction.objectStore('products');
                const categoryStore = transaction.objectStore('categories');
                const existingCategories = new Set();

                // Get all products
                const productsRequest = productStore.getAll();
                productsRequest.onsuccess = () => {
                    const products = productsRequest.result;
                    products.forEach(p => {
                        if (p.category) {
                            existingCategories.add(p.category.trim());
                        }
                    });
                     // Add default categories if they don't exist
                    ['Makanan', 'Minuman', 'Lainnya'].forEach(cat => existingCategories.add(cat));

                    // Add unique categories to the new store
                    existingCategories.forEach(categoryName => {
                        categoryStore.add({ name: categoryName });
                    });
                };
            }
        };
    });
}


function getFromDB(storeName, key) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject('Database not initialized');
            return;
        }
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.get(key);
        request.onsuccess = (event) => {
            resolve(event.target.result);
        };
        request.onerror = (event) => {
            reject('Error fetching from DB: ' + event.target.error);
        };
    });
}

function getAllFromDB(storeName) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject('Database not initialized');
            return;
        }
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.getAll();
        request.onsuccess = (event) => {
            resolve(event.target.result);
        };
        request.onerror = (event) => {
            reject('Error fetching all from DB: ' + event.target.error);
        };
    });
}


function putToDB(storeName, value) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject('Database not initialized');
            return;
        }
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.put(value);
        request.onsuccess = (event) => {
            resolve(event.target.result);
        };
        request.onerror = (event) => {
            reject('Error putting to DB: ' + event.target.error);
        };
    });
}


// --- UI & NAVIGATION ---
let isNavigating = false; // Flag to prevent multiple clicks during transition

async function showPage(pageName) {
    if (currentPage === pageName || isNavigating) return;
    isNavigating = true;

    const transitionDuration = 300; // Must match CSS transition duration

    const oldPage = document.querySelector('.page.active');
    const newPage = document.getElementById(pageName);

    if (!newPage) {
        isNavigating = false;
        return;
    }

    // Update nav item state immediately
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    const navItem = document.querySelector(`.nav-item[data-page="${pageName}"]`);
    if (navItem) navItem.classList.add('active');

    // Prepare the new page by setting its initial 'enter' state
    newPage.classList.add('page-enter');
    newPage.style.display = 'block';

    // Animate the old page out
    if (oldPage) {
        oldPage.classList.add('page-exit');
    }

    // Load data for the new page
    if (pageName === 'dashboard') {
        loadDashboard();
    } else if (pageName === 'kasir') {
        loadProductsGrid();
    } else if (pageName === 'produk') {
        loadProductsList();
    }

    // Force browser to apply start states before transitioning
    requestAnimationFrame(() => {
        // Animate the new page in
        newPage.classList.remove('page-enter');
        newPage.classList.add('active');

        // After transition, clean up the old page
        setTimeout(() => {
            if (oldPage) {
                oldPage.classList.remove('active');
                oldPage.classList.remove('page-exit');
                oldPage.style.display = 'none';
            }

            currentPage = pageName;
            isNavigating = false;

            // Post-transition actions like focusing
            if (pageName === 'kasir') {
                const searchInput = document.getElementById('searchProduct');
                if (searchInput) {
                    setTimeout(() => searchInput.focus(), 50);
                }
            }
        }, transitionDuration);
    });
}

// This function is called directly from the onclick attribute in the HTML
function handleNavClick(button) {
    const pageName = button.dataset.page;
    if (pageName) {
        showPage(pageName);
    }
}

function showToast(message, duration = 3000) {
    const toast = document.getElementById('toast');
    if (toast) {
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => {
            toast.classList.remove('show');
        }, duration);
    }
}

// --- FORMATTERS ---
function formatCurrency(amount) {
    // Use Math.round to avoid floating point issues with decimals
    return Math.round(amount).toLocaleString('id-ID');
}


// --- DASHBOARD ---
function loadDashboard() {
    const today = new Date();
    const todayString = today.toISOString().split('T')[0];
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    
    getAllFromDB('transactions').then(transactions => {
        let todaySales = 0;
        let todayTransactionsCount = 0;
        let monthSales = 0;
        
        transactions.forEach(t => {
            const transactionDate = t.date.split('T')[0];
            if (transactionDate === todayString) {
                todaySales += t.total;
                todayTransactionsCount++;
            }
            if (transactionDate >= monthStart) {
                monthSales += t.total;
            }
        });
        
        (document.getElementById('todaySales')).textContent = `Rp ${formatCurrency(todaySales)}`;
        (document.getElementById('todayTransactions')).textContent = todayTransactionsCount.toString();
        (document.getElementById('monthSales')).textContent = `Rp ${formatCurrency(monthSales)}`;
        
        const recent = transactions.sort((a, b) => b.id - a.id).slice(0, 5);
        displayRecentTransactions(recent);
    });
    
    getAllFromDB('products').then(products => {
        (document.getElementById('totalProducts')).textContent = products.length.toString();
        const lowStockCount = products.filter(p => p.stock > 0 && p.stock <= lowStockThreshold).length;
        const lowStockEl = document.getElementById('lowStockProducts');
        lowStockEl.textContent = lowStockCount.toString();
        lowStockEl.parentElement?.parentElement?.classList.toggle('animate-pulse', lowStockCount > 0);
    });

    getSettingFromDB('storeName').then(value => {
        const storeNameEl = document.getElementById('dashboardStoreName');
        if (storeNameEl) {
            storeNameEl.textContent = value || 'Dasbor';
        }
    });
    getSettingFromDB('storeAddress').then(value => {
        const storeAddressEl = document.getElementById('dashboardStoreAddress');
        if (storeAddressEl) {
            storeAddressEl.textContent = value || 'Pengaturan toko belum diisi';
        }
    });
}

function displayRecentTransactions(transactions) {
    const container = document.getElementById('recentTransactions');
    if (transactions.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-center py-4">Belum ada transaksi</p>';
        return;
    }
    container.innerHTML = transactions.map(t => `
        <div class="flex justify-between items-center py-2 border-b">
            <div>
                <p class="font-semibold">#${t.id.toString().padStart(4, '0')}</p>
                <p class="text-xs text-gray-500">${new Date(t.date).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</p>
            </div>
            <p class="font-semibold">Rp ${formatCurrency(t.total)}</p>
        </div>
    `).join('');
}

// --- CATEGORY MANAGEMENT ---
async function populateCategoryDropdowns(selectElementIds, selectedValue) {
    try {
        const categories = await getAllFromDB('categories');
        categories.sort((a, b) => a.name.localeCompare(b.name));

        selectElementIds.forEach(id => {
            const select = document.getElementById(id);
            if (!select) return;

            const isFilter = id === 'productCategoryFilter';
            
            // Preserve current value if it's a filter and it exists, otherwise reset
            const currentValue = isFilter ? select.value : selectedValue;
            select.innerHTML = ''; // Clear existing options

            if (isFilter) {
                const allOption = document.createElement('option');
                allOption.value = 'all';
                allOption.textContent = 'Semua Kategori';
                select.appendChild(allOption);
            } else {
                 const placeholder = document.createElement('option');
                 placeholder.value = '';
                 placeholder.textContent = 'Pilih Kategori...';
                 placeholder.disabled = true;
                 select.appendChild(placeholder);
            }

            categories.forEach(cat => {
                const option = document.createElement('option');
                option.value = cat.name;
                option.textContent = cat.name;
                select.appendChild(option);
            });
            
             // Restore selected value
            if (currentValue && select.querySelector(`option[value="${currentValue}"]`)) {
                select.value = currentValue;
            } else if (!isFilter) {
                select.selectedIndex = 0; // Select placeholder
            }
        });
    } catch (error) {
        console.error("Failed to populate categories:", error);
    }
}


async function showManageCategoryModal() {
    (document.getElementById('manageCategoryModal')).classList.remove('hidden');
    await loadCategoriesForManagement();
}

function closeManageCategoryModal() {
    (document.getElementById('manageCategoryModal')).classList.add('hidden');
    (document.getElementById('newCategoryName')).value = '';
}

async function loadCategoriesForManagement() {
    const listEl = document.getElementById('categoryList');
    const categories = await getAllFromDB('categories');
    categories.sort((a, b) => a.name.localeCompare(b.name));

    if (categories.length === 0) {
        listEl.innerHTML = `<p class="text-gray-500 text-center py-4">Belum ada kategori</p>`;
        return;
    }
    listEl.innerHTML = categories.map(cat => `
        <div class="flex justify-between items-center bg-gray-100 p-2 rounded-lg">
            <span>${cat.name}</span>
            <button onclick="deleteCategory(${cat.id}, '${cat.name}')" class="text-red-500 clickable"><i class="fas fa-trash"></i></button>
        </div>
    `).join('');
}

async function addNewCategory() {
    const input = document.getElementById('newCategoryName');
    const name = input.value.trim();
    if (!name) {
        showToast('Nama kategori tidak boleh kosong');
        return;
    }
    try {
        await putToDB('categories', { name });
        showToast('Kategori berhasil ditambahkan');
        input.value = '';
        await loadCategoriesForManagement();
        await populateCategoryDropdowns(['productCategory', 'editProductCategory', 'productCategoryFilter']);
    } catch (error) {
        showToast('Gagal menambahkan. Kategori mungkin sudah ada.');
        console.error("Add category error:", error);
    }
}

async function deleteCategory(id, name) {
    // Check if category is in use
    const products = await getAllFromDB('products');
    const isUsed = products.some(p => p.category === name);

    if (isUsed) {
        showToast(`Kategori "${name}" tidak dapat dihapus karena sedang digunakan oleh produk.`);
        return;
    }

    closeManageCategoryModal();

    showConfirmationModal(
        'Hapus Kategori',
        `Apakah Anda yakin ingin menghapus kategori "${name}"?`,
        () => {
            const transaction = db.transaction(['categories'], 'readwrite');
            const store = transaction.objectStore('categories');
            store.delete(id);
            transaction.oncomplete = async () => {
                showToast('Kategori berhasil dihapus');
                await populateCategoryDropdowns(['productCategory', 'editProductCategory', 'productCategoryFilter']);
            };
        },
        'Ya, Hapus',
        'bg-red-500'
    );
}


// --- PRODUCT MANAGEMENT ---
function loadProducts() {
    // This function can be used for initial load or background checks
    // The main loading for UI is done by loadProductsGrid and loadProductsList
}

function loadProductsGrid() {
    const grid = document.getElementById('productsGrid');
    getAllFromDB('products').then(products => {
        if (products.length === 0) {
            grid.innerHTML = `
                <div class="col-span-3 empty-state">
                    <div class="empty-state-icon"><i class="fas fa-box-open"></i></div>
                    <h3 class="empty-state-title">Belum Ada Produk</h3>
                    <p class="empty-state-description">Silakan tambahkan produk terlebih dahulu di halaman Produk</p>
                    <button onclick="showPage('produk')" class="empty-state-action">
                        <i class="fas fa-plus mr-2"></i>Tambah Produk
                    </button>
                </div>
            `;
            return;
        }
        grid.innerHTML = products.map(p => {
            const lowStockIndicator = p.stock > 0 && p.stock <= lowStockThreshold ? ` <i class="fas fa-exclamation-triangle text-yellow-500 text-xs" title="Stok Rendah"></i>` : '';
            
            let itemClasses = 'product-item clickable';
            if (p.stock === 0) {
                itemClasses += ' opacity-60 pointer-events-none';
            } else if (p.stock > 0 && p.stock <= lowStockThreshold) {
                itemClasses += ' low-stock-warning';
            }

            return `
            <div class="${itemClasses}" onclick="addToCart(${p.id})" data-name="${p.name.toLowerCase()}" data-category="${p.category.toLowerCase()}" data-barcode="${p.barcode || ''}">
                ${p.image ? `<img src="${p.image}" alt="${p.name}" class="product-image">` : `<div class="bg-gray-100 rounded-lg p-4 mb-2"><i class="fas fa-box text-3xl text-gray-400"></i></div>`}
                <h3 class="font-semibold text-sm">${p.name}</h3>
                <p class="text-blue-500 font-bold">Rp ${formatCurrency(p.price)}</p>
                <p class="text-xs text-gray-500">Stok: ${p.stock}${lowStockIndicator}</p>
            </div>
        `}).join('');
    });
}

async function loadProductsList() {
    const list = document.getElementById('productsList');
    const filterSelect = document.getElementById('productCategoryFilter');
    
    // Ensure filter is populated before using its value
    await populateCategoryDropdowns(['productCategoryFilter']);
    
    const selectedCategory = filterSelect ? filterSelect.value : 'all';

    getAllFromDB('products').then(products => {
        const filteredProducts = selectedCategory === 'all' 
            ? products 
            : products.filter(p => p.category === selectedCategory);

        if (filteredProducts.length === 0) {
            if (products.length === 0) {
                list.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon"><i class="fas fa-box-open"></i></div>
                        <h3 class="empty-state-title">Belum Ada Produk</h3>
                        <p class="empty-state-description">Mulai tambahkan produk untuk melihatnya di sini</p>
                        <button onclick="showAddProductModal()" class="empty-state-action">
                            <i class="fas fa-plus mr-2"></i>Tambah Produk Pertama
                        </button>
                    </div>
                `;
            } else {
                list.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon"><i class="fas fa-search"></i></div>
                        <h3 class="empty-state-title">Produk Tidak Ditemukan</h3>
                        <p class="empty-state-description">Tidak ada produk dalam kategori "${selectedCategory}"</p>
                    </div>
                `;
            }
            return;
        }
        list.innerHTML = filteredProducts.sort((a, b) => a.name.localeCompare(b.name)).map(p => {
            const profit = p.price - p.purchasePrice;
            const profitMargin = p.purchasePrice > 0 ? ((profit / p.purchasePrice) * 100).toFixed(1) : '&#8734;';
            const lowStockBadge = p.stock > 0 && p.stock <= lowStockThreshold ? '<span class="low-stock-badge">Stok Rendah</span>' : '';
            const outOfStockClass = p.stock === 0 ? 'opacity-60' : '';
            const lowStockClass = p.stock > 0 && p.stock <= lowStockThreshold ? 'low-stock-warning' : '';
            return `
                <div class="card p-4 ${outOfStockClass} ${lowStockClass}">
                    <div class="flex gap-3">
                        ${p.image ? `<img src="${p.image}" alt="${p.name}" class="product-list-image">` : `<div class="bg-gray-100 rounded-lg p-4 flex items-center justify-center" style="width: 60px; height: 60px;"><i class="fas fa-box text-2xl text-gray-400"></i></div>`}
                        <div class="flex-1">
                            <div class="flex justify-between items-start mb-2">
                                <div>
                                    <h3 class="font-semibold">${p.name}</h3>
                                    <p class="text-sm text-gray-600">${p.category}</p>
                                </div>
                                <div class="flex gap-2">
                                    <button onclick="editProduct(${p.id})" class="text-blue-500 clickable"><i class="fas fa-edit"></i></button>
                                    <button onclick="deleteProduct(${p.id})" class="text-red-500 clickable"><i class="fas fa-trash"></i></button>
                                </div>
                            </div>
                            <div class="flex justify-between items-center">
                                <div>
                                    <p class="text-blue-500 font-bold">Rp ${formatCurrency(p.price)}</p>
                                    <p class="text-xs text-gray-500">Beli: Rp ${formatCurrency(p.purchasePrice)}</p>
                                </div>
                                <div class="text-right flex items-center gap-2">
                                    ${lowStockBadge}
                                    <div>
                                        <p class="text-sm text-gray-500">Stok: ${p.stock}</p>
                                        <span class="profit-badge">+${profitMargin}%</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    });
}


// Add Product Modal
function showAddProductModal() {
    (document.getElementById('addProductModal')).classList.remove('hidden');
    populateCategoryDropdowns(['productCategory']);
}

function closeAddProductModal() {
    (document.getElementById('addProductModal')).classList.add('hidden');
    (document.getElementById('productName')).value = '';
    (document.getElementById('productPrice')).value = '';
    (document.getElementById('productPurchasePrice')).value = '';
    (document.getElementById('productStock')).value = '';
    (document.getElementById('productBarcode')).value = '';
    (document.getElementById('productCategory')).value = '';
    (document.getElementById('imagePreview')).innerHTML = `<i class="fas fa-camera text-3xl mb-2"></i><p>Tap untuk upload gambar</p>`;
    currentImageData = null;
}

function previewImage(event) {
    const file = event.target.files?.[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            currentImageData = e.target?.result;
            (document.getElementById('imagePreview')).innerHTML = `<img src="${currentImageData}" alt="Preview" class="image-preview">`;
        };
        reader.readAsDataURL(file);
    }
}

function addProduct() {
    const name = (document.getElementById('productName')).value;
    const price = parseInt((document.getElementById('productPrice')).value);
    const purchasePrice = parseInt((document.getElementById('productPurchasePrice')).value);
    const stock = parseInt((document.getElementById('productStock')).value);
    const category = (document.getElementById('productCategory')).value;
    const barcode = (document.getElementById('productBarcode')).value;

    if (!name || isNaN(price) || isNaN(purchasePrice) || isNaN(stock) || !category) {
        showToast('Semua field harus diisi dengan benar');
        return;
    }
     if (price < 0 || purchasePrice < 0 || stock < 0) {
        showToast('Nilai harga dan stok tidak boleh negatif');
        return;
    }
    if (purchasePrice >= price) {
        showToast('Harga jual harus lebih besar dari harga beli');
        return;
    }
    
    const newProduct = { name, price, purchasePrice, stock, category, barcode, image: currentImageData };
    
    const transaction = db.transaction(['products'], 'readwrite');
    const store = transaction.objectStore('products');
    const request = store.add(newProduct);
    
    request.onsuccess = () => {
        showToast('Produk berhasil ditambahkan');
        closeAddProductModal();
        loadProductsList();
        loadProductsGrid();
        loadDashboard();
    };
    request.onerror = () => {
        showToast('Gagal menambahkan produk. Barcode mungkin sudah ada.');
    }
}

// Edit Product Modal
async function editProduct(id) {
    const product = await getFromDB('products', id);
    if (product) {
        await populateCategoryDropdowns(['editProductCategory'], product.category);
        (document.getElementById('editProductId')).value = id.toString();
        (document.getElementById('editProductName')).value = product.name;
        (document.getElementById('editProductPrice')).value = product.price.toString();
        (document.getElementById('editProductPurchasePrice')).value = product.purchasePrice.toString();
        (document.getElementById('editProductStock')).value = product.stock.toString();
        (document.getElementById('editProductCategory')).value = product.category;
        (document.getElementById('editProductBarcode')).value = product.barcode || '';
        currentEditImageData = product.image;
        const preview = document.getElementById('editImagePreview');
        if (product.image) {
            preview.innerHTML = `<img src="${product.image}" alt="Preview" class="image-preview">`;
        } else {
            preview.innerHTML = `<i class="fas fa-camera text-3xl mb-2"></i><p>Tap untuk ubah gambar</p>`;
        }
        (document.getElementById('editProductModal')).classList.remove('hidden');
    }
}

function closeEditProductModal() {
    (document.getElementById('editProductModal')).classList.add('hidden');
}

function previewEditImage(event) {
    const file = event.target.files?.[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            currentEditImageData = e.target?.result;
            (document.getElementById('editImagePreview')).innerHTML = `<img src="${currentEditImageData}" alt="Preview" class="image-preview">`;
        };
        reader.readAsDataURL(file);
    }
}

function updateProduct() {
    const id = parseInt((document.getElementById('editProductId')).value);
    const name = (document.getElementById('editProductName')).value;
    const price = parseInt((document.getElementById('editProductPrice')).value);
    const purchasePrice = parseInt((document.getElementById('editProductPurchasePrice')).value);
    const stock = parseInt((document.getElementById('editProductStock')).value);
    const category = (document.getElementById('editProductCategory')).value;
    const barcode = (document.getElementById('editProductBarcode')).value;

    if (!name || isNaN(price) || isNaN(purchasePrice) || isNaN(stock) || !category) {
        showToast('Semua field harus diisi dengan benar');
        return;
    }
    if (price < 0 || purchasePrice < 0 || stock < 0) {
        showToast('Nilai harga dan stok tidak boleh negatif');
        return;
    }
    if (purchasePrice >= price) {
        showToast('Harga jual harus lebih besar dari harga beli');
        return;
    }
    
    const updatedProduct = { id, name, price, purchasePrice, stock, category, barcode, image: currentEditImageData };
    
    putToDB('products', updatedProduct).then(() => {
        showToast('Produk berhasil diperbarui');
        closeEditProductModal();
        loadProductsList();
        loadProductsGrid();
    }).catch(() => {
        showToast('Gagal memperbarui produk. Barcode mungkin sudah ada.');
    });
}

function deleteProduct(id) {
    getFromDB('products', id).then(product => {
        if (!product) {
            showToast('Produk tidak ditemukan.');
            return;
        }
        showConfirmationModal(
            'Hapus Produk',
            `Apakah Anda yakin ingin menghapus produk "${product.name}"?`,
            () => {
                const transaction = db.transaction(['products'], 'readwrite');
                const store = transaction.objectStore('products');
                const request = store.delete(id);
                request.onsuccess = () => {
                    showToast('Produk berhasil dihapus');
                    loadProductsList();
                    loadProductsGrid();
                    loadDashboard();
                };
                request.onerror = () => {
                    showToast('Gagal menghapus produk.');
                };
            },
            'Ya, Hapus',
            'bg-red-500'
        );
    });
}

// --- CART & CHECKOUT ---
// Refreshes payment modal totals and focuses the cash input if the modal is open
function refreshPaymentModalAndFocus() {
    const paymentModal = document.getElementById('paymentModal');
    if (paymentModal.classList.contains('hidden')) {
        return; // Do nothing if the modal is not open
    }

    // Recalculate total and update display
    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    (document.getElementById('paymentTotal')).textContent = `Rp ${formatCurrency(total)}`;
    
    // Recalculate change
    calculateChange();
    
    // Focus the input
    const cashPaidInput = document.getElementById('cashPaidInput');
    cashPaidInput.focus();
    cashPaidInput.select(); // Select the text for easy replacement
}

function addToCart(productId) {
    getFromDB('products', productId).then(product => {
        if (!product) {
            showToast('Produk tidak ditemukan');
            return;
        }
        if (product.stock <= 0) {
            showToast('Stok habis');
            return;
        }
        
        const existingItem = cart.find(item => item.id === productId);
        if (existingItem) {
            if (existingItem.quantity >= product.stock) {
                showToast('Stok tidak mencukupi');
                return;
            }
            existingItem.quantity++;
        } else {
            cart.push({ id: product.id, name: product.name, price: product.price, quantity: 1 });
        }
        
        updateCartDisplay();
        refreshPaymentModalAndFocus();
        showToast(`${product.name} ditambahkan`);
    });
}

function updateCartDisplay() {
    const cartItemsEl = document.getElementById('cartItems');
    const cartTotalEl = document.getElementById('cartTotal');
    
    if (cart.length === 0) {
        cartItemsEl.innerHTML = '<p class="text-gray-500 text-center py-4">Keranjang kosong</p>';
        cartTotalEl.textContent = 'Rp 0';
        return;
    }
    
    let total = 0;
    cartItemsEl.innerHTML = cart.map(item => {
        const subtotal = item.price * item.quantity;
        total += subtotal;
        return `
            <div class="cart-item">
                <div class="flex justify-between items-center">
                    <div class="flex-1">
                        <h4 class="font-semibold">${item.name}</h4>
                        <p class="text-sm text-gray-600">Rp ${formatCurrency(item.price)} x ${item.quantity}</p>
                    </div>
                    <div class="flex items-center gap-2">
                        <button onclick="decreaseQuantity(${item.id})" class="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center clickable"><i class="fas fa-minus text-xs"></i></button>
                        <span>${item.quantity}</span>
                        <button onclick="increaseQuantity(${item.id})" class="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center clickable"><i class="fas fa-plus text-xs"></i></button>
                        <span class="font-semibold w-20 text-right">Rp ${formatCurrency(subtotal)}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    cartTotalEl.textContent = `Rp ${formatCurrency(total)}`;
}

function increaseQuantity(productId) {
    getFromDB('products', productId).then(product => {
        if (!product) return;
        const cartItem = cart.find(item => item.id === productId);
        if (cartItem) {
            if (cartItem.quantity >= product.stock) {
                showToast('Stok tidak mencukupi');
                return;
            }
            cartItem.quantity++;
            updateCartDisplay();
            refreshPaymentModalAndFocus();
        }
    });
}

function decreaseQuantity(productId) {
    const cartItem = cart.find(item => item.id === productId);
    if (cartItem) {
        if (cartItem.quantity > 1) {
            cartItem.quantity--;
        } else {
            cart = cart.filter(item => item.id !== productId);
        }
        updateCartDisplay();
        refreshPaymentModalAndFocus();
    }
}

function clearCart() {
    if (cart.length === 0) return;
    showConfirmationModal(
        'Kosongkan Keranjang',
        'Apakah Anda yakin ingin mengosongkan keranjang?',
        () => {
            cart = [];
            updateCartDisplay();
            showToast('Keranjang dikosongkan');
        },
        'Ya, Kosongkan',
        'bg-red-500'
    );
}

function completeTransaction() {
    if (cart.length === 0) {
        showToast('Keranjang kosong');
        return;
    }

    const cashPaidInput = document.getElementById('cashPaidInput');
    const cashPaid = parseInt(cashPaidInput.value) || 0;
    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const change = cashPaid - total;

    if (cashPaid < total) {
        showToast('Uang yang dibayarkan tidak cukup');
        return;
    }

    // Show spinner on the button
    const completeButton = document.getElementById('completeTransactionButton');
    if (completeButton) {
        const buttonText = completeButton.querySelector('.payment-button-text');
        const buttonSpinner = completeButton.querySelector('.payment-button-spinner');
        
        completeButton.disabled = true;
        buttonText?.classList.add('hidden');
        buttonSpinner?.classList.remove('hidden');
    }

    // Close the payment modal first
    closePaymentModal();

    // Use a short delay for a smoother transition before showing confirmation
    setTimeout(() => {
        const confirmationMessage = `
            <div class="space-y-2 text-left text-sm">
                <div class="flex justify-between">
                    <span>Total Belanja:</span>
                    <span class="font-semibold">Rp ${formatCurrency(total)}</span>
                </div>
                <div class="flex justify-between">
                    <span>Uang Tunai:</span>
                    <span class="font-semibold">Rp ${formatCurrency(cashPaid)}</span>
                </div>
                <div class="flex justify-between border-t pt-2 mt-2">
                    <span class="font-semibold">Kembalian:</span>
                    <span class="font-bold text-green-500">Rp ${formatCurrency(change)}</span>
                </div>
            </div>
            <p class="mt-4 text-center text-sm">Lanjutkan untuk menyelesaikan transaksi?</p>
        `;

        showConfirmationModal(
            'Konfirmasi Transaksi',
            confirmationMessage,
            () => {
                const transaction = db.transaction(['transactions', 'products'], 'readwrite');
                const transactionStore = transaction.objectStore('transactions');
                const productStore = transaction.objectStore('products');

                const newTransaction = {
                    date: new Date().toISOString(),
                    items: [...cart],
                    total,
                    cashPaid,
                    change
                };

                const request = transactionStore.add(newTransaction);

                request.onsuccess = (event) => {
                    const transactionId = event.target.result;

                    cart.forEach(item => {
                        productStore.get(item.id).onsuccess = (event) => {
                            const product = event.target.result;
                            if (product) {
                                product.stock -= item.quantity;
                                productStore.put(product);
                            }
                        };
                    });

                    cart = [];
                    updateCartDisplay();
                    showReceiptModal(transactionId, undefined, false);
                };
                request.onerror = () => {
                    showToast('Gagal menyelesaikan transaksi.');
                };
            },
            'Ya, Selesaikan',
            'bg-blue-500'
        );
    }, 200); // 200ms delay for modal close animation
}


// --- REPORTS ---
function generateReport() {
    const dateFrom = (document.getElementById('dateFrom')).value;
    const dateTo = (document.getElementById('dateTo')).value;
    
    if (!dateFrom || !dateTo) {
        showToast('Pilih rentang tanggal');
        return;
    }
    
    getAllFromDB('transactions').then(transactions => {
        const filtered = transactions.filter(t => {
            const transactionDate = t.date.split('T')[0];
            return transactionDate >= dateFrom && transactionDate <= dateTo;
        });
        
        currentReportData = filtered; // Store for export

        const totalSales = filtered.reduce((sum, t) => sum + t.total, 0);
        const totalTransactions = filtered.length;
        const average = totalTransactions > 0 ? totalSales / totalTransactions : 0;
        
        (document.getElementById('reportTotalSales')).textContent = `Rp ${formatCurrency(totalSales)}`;
        (document.getElementById('reportTotalTransactions')).textContent = totalTransactions.toString();
        (document.getElementById('reportAverage')).textContent = `Rp ${formatCurrency(average)}`;
        
        displayReportTransactions(filtered);

        // Calculate and display top selling products
        const productSales = {};

        filtered.forEach(transaction => {
            transaction.items.forEach(item => {
                if (!productSales[item.id]) {
                    productSales[item.id] = { name: item.name, quantity: 0, total: 0 };
                }
                productSales[item.id].quantity += item.quantity;
                productSales[item.id].total += item.price * item.quantity;
            });
        });

        const topProducts = Object.values(productSales)
            .sort((a, b) => b.quantity - a.quantity)
            .slice(0, 5);

        displayTopSellingProducts(topProducts);
        
        (document.getElementById('reportSummary')).style.display = 'block';
        (document.getElementById('reportDetails')).style.display = 'block';
    });
}

function displayTopSellingProducts(topProducts) {
    const container = document.getElementById('topSellingProductsList');
    const card = document.getElementById('topSellingProductsCard');

    if (topProducts.length === 0) {
        card.style.display = 'none';
        return;
    }

    container.innerHTML = topProducts.map((p, index) => `
        <div class="flex justify-between items-center py-2 border-b last:border-b-0">
            <div class="flex items-center gap-3">
                <span class="font-bold text-gray-500 w-6 text-center">${index + 1}.</span>
                <div>
                    <p class="font-semibold">${p.name}</p>
                    <p class="text-xs text-gray-500">${p.quantity} terjual</p>
                </div>
            </div>
            <p class="font-semibold text-green-600">Rp ${formatCurrency(p.total)}</p>
        </div>
    `).join('');

    card.style.display = 'block';
}


function displayReportTransactions(transactions) {
    const container = document.getElementById('reportTransactions');
    if (transactions.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-center py-4">Tidak ada transaksi</p>';
        return;
    }
    container.innerHTML = transactions.sort((a,b) => b.id - a.id).map(t => `
        <div class="flex justify-between items-center py-2 border-b">
            <div>
                <p class="font-semibold">#${t.id.toString().padStart(4, '0')}</p>
                <p class="text-xs text-gray-500">${new Date(t.date).toLocaleString('id-ID')}</p>
            </div>
            <div class="flex items-center gap-4">
                <p class="font-semibold">Rp ${formatCurrency(t.total)}</p>
                <button onclick="deleteTransaction(${t.id})" class="text-red-500 clickable text-lg"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `).join('');
}

function deleteTransaction(id) {
    showConfirmationModal(
        'Hapus Transaksi',
        `Yakin ingin menghapus transaksi #${id}? Stok produk akan dikembalikan. Tindakan ini tidak dapat dibatalkan.`,
        () => {
            getFromDB('transactions', id).then(transactionToDelete => {
                if (!transactionToDelete) {
                    showToast('Transaksi tidak ditemukan.');
                    return;
                }
                
                const tx = db.transaction(['transactions', 'products'], 'readwrite');
                const transactionStore = tx.objectStore('transactions');
                const productStore = tx.objectStore('products');

                // Delete the transaction record
                transactionStore.delete(id);

                // Update stock for each item
                transactionToDelete.items.forEach(item => {
                    const getRequest = productStore.get(item.id);
                    getRequest.onsuccess = () => {
                        const product = getRequest.result;
                        if (product) {
                            product.stock += item.quantity;
                            productStore.put(product);
                        }
                    };
                });

                tx.oncomplete = () => {
                    showToast(`Transaksi #${id} berhasil dihapus.`);
                    generateReport(); // Refresh the report view
                    loadDashboard(); // Refresh dashboard stats
                };

                tx.onerror = (event) => {
                    console.error('Transaction delete error:', event.target.error);
                    showToast('Gagal menghapus transaksi.');
                };
            }).catch(err => {
                console.error('Failed to get transaction for deletion:', err);
                showToast('Gagal memuat detail transaksi untuk dihapus.');
            });
        },
        'Ya, Hapus',
        'bg-red-500'
    );
}

function convertToCSV(data, headers) {
    const escapeCell = (cell) => {
        const str = String(cell ?? ''); // Handle null/undefined
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    const headerRow = headers.map(escapeCell).join(',');
    const contentRows = data.map(row => row.map(escapeCell).join(','));
    
    return [headerRow, ...contentRows].join('\n');
}

async function exportReportToCSV() {
    if (currentReportData.length === 0) {
        showToast('Tidak ada data laporan untuk diexport');
        return;
    }

    showToast('Mempersiapkan file CSV...', 2000);

    try {
        const allProducts = await getAllFromDB('products');
        const productMap = new Map(allProducts.map(p => [p.id, p]));

        const headers = [
            'ID Transaksi', 'Tanggal', 'Waktu', 
            'Nama Produk', 'Kategori', 'Barcode',
            'Harga Beli', 'Harga Jual', 'Jumlah', 'Subtotal'
        ];

        const rows = [];
        currentReportData.forEach(transaction => {
            const transactionDate = new Date(transaction.date);
            const date = transactionDate.toLocaleDateString('id-ID', { year: 'numeric', month: '2-digit', day: '2-digit' });
            const time = transactionDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

            transaction.items.forEach(item => {
                const productDetails = productMap.get(item.id);
                const row = [
                    transaction.id,
                    date,
                    time,
                    item.name,
                    productDetails?.category || 'N/A',
                    productDetails?.barcode || 'N/A',
                    productDetails?.purchasePrice || 0,
                    item.price,
                    item.quantity,
                    item.price * item.quantity
                ];
                rows.push(row);
            });
        });

        const csvContent = convertToCSV(rows, headers);
        const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' }); // Add BOM for Excel compatibility
        
        const dateFrom = (document.getElementById('dateFrom')).value;
        const dateTo = (document.getElementById('dateTo')).value;
        const filename = `Laporan_Penjualan_${dateFrom}_sampai_${dateTo}.csv`;

        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute("download", filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

    } catch (error) {
        console.error("Gagal export CSV:", error);
        showToast('Terjadi kesalahan saat export data');
    }
}


// --- SETTINGS ---

function updatePrintStyles(paperSize) {
    const styleEl = document.getElementById('print-style-overrides');
    if (!styleEl) return;

    let css = '';
    if (paperSize === '58mm') {
        css = `
            @page {
                size: 58mm auto;
                margin: 3mm;
            }
            @media print {
                #receiptContent {
                    font-size: 9pt;
                }
                #receiptModal .receipt-header h2 {
                    font-size: 11pt;
                }
            }
        `;
    } else { // Default to 80mm
        css = `
            @page {
                size: 80mm auto;
                margin: 5mm;
            }
            @media print {
                #receiptContent {
                    font-size: 10pt;
                }
                #receiptModal .receipt-header h2 {
                    font-size: 12pt;
                }
            }
        `;
    }
    styleEl.innerHTML = css;
}

function getSettingFromDB(key) {
    return new Promise((resolve) => {
        getFromDB('settings', key).then(setting => {
            resolve(setting ? setting.value : null);
        });
    });
}

function putSettingToDB(setting) {
    return putToDB('settings', setting);
}

function loadStoreSettings() {
    getSettingFromDB('storeName').then(value => (document.getElementById('storeName')).value = value || '');
    getSettingFromDB('storeAddress').then(value => (document.getElementById('storeAddress')).value = value || '');
    getSettingFromDB('storeFeedbackPhone').then(value => (document.getElementById('storeFeedbackPhone')).value = value || '');
    getSettingFromDB('storeFooterText').then(value => (document.getElementById('storeFooterText')).value = value || 'Terima Kasih!');
    getSettingFromDB('lowStockThreshold').then(value => {
        const threshold = value ? parseInt(value) : 5;
        lowStockThreshold = threshold;
        (document.getElementById('lowStockThreshold')).value = threshold.toString();
    });
    getSettingFromDB('storeLogo').then(value => {
        currentStoreLogoData = value;
        if (value) {
            (document.getElementById('storeLogoPreview')).innerHTML = `<img src="${value}" alt="Logo" class="image-preview">`;
        }
    });
    getSettingFromDB('autoPrintReceipt').then(value => {
        (document.getElementById('autoPrintReceipt')).checked = !!value;
    });
    getSettingFromDB('printerPaperSize').then(value => {
        const paperSize = value || '80mm';
        (document.getElementById('printerPaperSize')).value = paperSize;
        updatePrintStyles(paperSize);
    });
}

function saveStoreSettings() {
    const storeName = (document.getElementById('storeName')).value;
    const storeAddress = (document.getElementById('storeAddress')).value;
    const storeFeedbackPhone = (document.getElementById('storeFeedbackPhone')).value;
    const storeFooterText = (document.getElementById('storeFooterText')).value;
    const threshold = (document.getElementById('lowStockThreshold')).value;
    const autoPrintReceipt = (document.getElementById('autoPrintReceipt')).checked;
    const printerPaperSize = (document.getElementById('printerPaperSize')).value;
    
    updatePrintStyles(printerPaperSize);
    lowStockThreshold = parseInt(threshold) || 5;

    const promises = [
        putSettingToDB({ key: 'storeName', value: storeName }),
        putSettingToDB({ key: 'storeAddress', value: storeAddress }),
        putSettingToDB({ key: 'storeFeedbackPhone', value: storeFeedbackPhone }),
        putSettingToDB({ key: 'storeFooterText', value: storeFooterText }),
        putSettingToDB({ key: 'lowStockThreshold', value: lowStockThreshold }),
        putSettingToDB({ key: 'storeLogo', value: currentStoreLogoData }),
        putSettingToDB({ key: 'autoPrintReceipt', value: autoPrintReceipt }),
        putSettingToDB({ key: 'printerPaperSize', value: printerPaperSize }),
    ];
    
    Promise.all(promises).then(() => {
        showToast('Pengaturan berhasil disimpan');
        loadDashboard();
        loadProductsGrid();
        loadProductsList();
    });
}

function previewStoreLogo(event) {
    const file = event.target.files?.[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            currentStoreLogoData = e.target?.result;
            (document.getElementById('storeLogoPreview')).innerHTML = `<img src="${currentStoreLogoData}" alt="Logo" class="image-preview">`;
        };
        reader.readAsDataURL(file);
    }
}

// Data Management
function exportData() {
    Promise.all([
        getAllFromDB('products'),
        getAllFromDB('transactions'),
        getAllFromDB('settings'),
    ]).then(([products, transactions, settingsArray]) => {
        const settings = {};
        settingsArray.forEach(s => settings[s.key] = s.value);
        
        const data = {
            products,
            transactions,
            settings,
            exportDate: new Date().toISOString()
        };
        
        const dataStr = JSON.stringify(data, null, 2);
        const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
        const exportFileDefaultName = `pos_backup_${new Date().toISOString().split('T')[0]}.json`;
        
        const linkElement = document.createElement('a');
        linkElement.setAttribute('href', dataUri);
        linkElement.setAttribute('download', exportFileDefaultName);
        linkElement.click();
        
        showToast('Data berhasil diekspor');
    });
}

function importData() {
    (document.getElementById('importFile')).click();
}

function handleImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target?.result);
            
            showConfirmationModal(
                'Import Data',
                'Import akan menggantikan semua data yang ada. Lanjutkan?',
                () => {
                    const storesToClear = ['products', 'transactions', 'settings', 'categories'];
                    const clearTransaction = db.transaction(storesToClear, 'readwrite');
                    storesToClear.forEach(store => clearTransaction.objectStore(store).clear());
                    
                    clearTransaction.oncomplete = () => {
                        const importTransaction = db.transaction(storesToClear, 'readwrite');
                        const productStore = importTransaction.objectStore('products');
                        const transactionStore = importTransaction.objectStore('transactions');
                        const settingsStore = importTransaction.objectStore('settings');
                        const categoryStore = importTransaction.objectStore('categories');
                         
                        const categoriesToImport = new Set();

                        if (data.products) {
                            data.products.forEach((p) => {
                                productStore.add(p);
                                if(p.category) categoriesToImport.add(p.category);
                            });
                        }
                        if (data.transactions) data.transactions.forEach((t) => transactionStore.add(t));
                        if (data.settings) Object.keys(data.settings).forEach(key => settingsStore.add({ key, value: data.settings[key] }));
                        
                        // Add default and imported categories
                        ['Makanan', 'Minuman', 'Lainnya'].forEach(c => categoriesToImport.add(c));
                        categoriesToImport.forEach(catName => categoryStore.add({ name: catName }));

                        importTransaction.oncomplete = () => {
                            showToast('Data berhasil diimpor');
                            loadDashboard();
                            loadProductsList();
                            loadProductsGrid();
                            loadStoreSettings();
                        };
                    };
                },
                'Ya, Lanjutkan',
                'bg-purple-500'
            );
        } catch (error) {
            showToast('Gagal mengimpor: file tidak valid');
        }
    };
    reader.readAsText(file);
}

function clearAllData() {
    showConfirmationModal(
        'Hapus Semua Data',
        'APAKAH ANDA YAKIN? Semua data (produk, kategori, transaksi, dll) akan dihapus permanen. Tindakan ini tidak dapat dibatalkan.',
        () => {
            const storesToClear = ['products', 'transactions', 'settings', 'auto_backup', 'categories'];
            const transaction = db.transaction(storesToClear, 'readwrite');
            storesToClear.forEach(store => transaction.objectStore(store).clear());

            transaction.oncomplete = () => {
                cart = [];
                updateCartDisplay();
                showToast('Semua data berhasil dihapus');
                loadDashboard();
                loadProductsList();
                loadProductsGrid();
                loadStoreSettings();
            };
        },
        'Ya, Hapus Semua',
        'bg-red-500'
    );
}

// --- AUTO BACKUP & RESTORE ---
async function autoBackupData() {
    if (!db) return;
    try {
        const [products, transactions, settingsArray] = await Promise.all([
            getAllFromDB('products'),
            getAllFromDB('transactions'),
            getAllFromDB('settings'),
        ]);

        if (products.length === 0 && transactions.length === 0) {
            console.log("Auto backup skipped: No data to back up.");
            return;
        }

        const settings = {};
        settingsArray.forEach(s => settings[s.key] = s.value);

        const backupData = {
            products,
            transactions,
            settings,
            backupDate: new Date().toISOString()
        };

        await putToDB('auto_backup', { key: 'last_backup', value: backupData });
        const todayString = new Date().toISOString().split('T')[0];
        await putToDB('auto_backup', { key: 'last_backup_date', value: todayString });
        console.log('Auto backup successful for', todayString);
    } catch (error) {
        console.error('Auto backup failed:', error);
    }
}

async function runDailyBackupCheck() {
    try {
        const todayString = new Date().toISOString().split('T')[0];
        const lastBackupRecord = await getFromDB('auto_backup', 'last_backup_date');
        const lastBackupDate = lastBackupRecord ? lastBackupRecord.value : null;

        if (lastBackupDate !== todayString) {
            console.log("Previous backup was on", lastBackupDate, "- Running daily auto backup now.");
            await autoBackupData();
        } else {
            console.log("Daily auto backup has already been performed today.");
        }
    } catch (error) {
        console.error("Failed to run daily backup check:", error);
    }
}

async function restoreDataFromBackup() {
    const backupRecord = await getFromDB('auto_backup', 'last_backup');
    if (!backupRecord || !backupRecord.value) {
        showToast('Backup tidak ditemukan.');
        return;
    }

    try {
        const data = backupRecord.value;
        const { products, transactions, settings } = data;
        const stores = ['products', 'transactions', 'settings', 'categories'];
        const importTransaction = db.transaction(stores, 'readwrite');
        const productStore = importTransaction.objectStore('products');
        const transactionStore = importTransaction.objectStore('transactions');
        const settingsStore = importTransaction.objectStore('settings');
        const categoryStore = importTransaction.objectStore('categories');

        productStore.clear();
        transactionStore.clear();
        settingsStore.clear();
        categoryStore.clear();
        
        const categoriesToRestore = new Set();

        if (products) {
            products.forEach((p) => {
                productStore.add(p);
                if(p.category) categoriesToRestore.add(p.category);
            });
        }
        if (transactions) transactions.forEach((t) => transactionStore.add(t));
        if (settings) Object.keys(settings).forEach((key) => settingsStore.add({ key, value: settings[key] }));
        
        // Add default and restored categories
        ['Makanan', 'Minuman', 'Lainnya'].forEach(c => categoriesToRestore.add(c));
        categoriesToRestore.forEach(catName => categoryStore.add({ name: catName }));


        importTransaction.oncomplete = () => {
            showToast('Data berhasil dipulihkan dari backup');
            loadDashboard();
            loadProductsList();
            loadProductsGrid();
            loadStoreSettings();
        };

        importTransaction.onerror = () => {
             showToast('Gagal memulihkan data.');
        }

    } catch (error) {
        showToast('Gagal memulihkan data: file backup rusak.');
        console.error('Restore failed:', error);
    }
}

async function checkForRestore() {
    const backupRecord = await getFromDB('auto_backup', 'last_backup');
    if (!backupRecord || !backupRecord.value) {
        return; 
    }

    const productCount = (await getAllFromDB('products')).length;
    if (productCount > 0) {
        return;
    }
    
    try {
        const backupData = backupRecord.value;
        const backupDate = new Date(backupData.backupDate).toLocaleString('id-ID', {
            day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });

        if (backupData.products.length > 0 || backupData.transactions.length > 0) {
             showConfirmationModal(
                'Pulihkan Data',
                `Kami menemukan backup data otomatis dari ${backupDate}. Apakah Anda ingin memulihkannya?`,
                restoreDataFromBackup,
                'Ya, Pulihkan',
                'bg-green-500'
            );
        }
    } catch (error) {
        console.error("Could not parse auto backup data:", error);
    }
}

// --- MODALS ---
// Confirmation Modal
function showConfirmationModal(title, message, onConfirm, confirmText = 'Konfirmasi', confirmClass = 'bg-red-500') {
    (document.getElementById('confirmationTitle')).textContent = title;
    (document.getElementById('confirmationMessage')).innerHTML = message;
    
    const confirmButton = document.getElementById('confirmButton');
    confirmButton.textContent = confirmText;

    // A simple way to manage color classes by removing potential old ones
    const colorClasses = ['bg-red-500', 'bg-purple-500', 'bg-blue-500', 'bg-green-500'];
    confirmButton.classList.remove(...colorClasses);
    confirmButton.classList.add(confirmClass);
    
    confirmCallback = onConfirm;
    (document.getElementById('confirmationModal')).classList.remove('hidden');
}

function closeConfirmationModal() {
    (document.getElementById('confirmationModal')).classList.add('hidden');
    confirmCallback = null;
}

// Payment Modal
function showPaymentModal() {
    if (cart.length === 0) {
        showToast('Keranjang kosong');
        return;
    }
    
    // Reset button state every time modal is shown
    const completeButton = document.getElementById('completeTransactionButton');
    if (completeButton) {
        const buttonText = completeButton.querySelector('.payment-button-text');
        const buttonSpinner = completeButton.querySelector('.payment-button-spinner');
        
        completeButton.disabled = true; // Will be enabled by calculateChange if valid
        buttonText?.classList.remove('hidden');
        buttonSpinner?.classList.add('hidden');
    }

    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const cashPaidInput = document.getElementById('cashPaidInput');
    (document.getElementById('paymentTotal')).textContent = `Rp ${formatCurrency(total)}`;
    cashPaidInput.value = '';
    
    // Set initial state by calculating change with 0 cash paid
    calculateChange();
    
    (document.getElementById('paymentModal')).classList.remove('hidden');

    // Automatically focus the input field for a smoother workflow
    setTimeout(() => {
        cashPaidInput.focus();
    }, 100); // Use a short delay to ensure the modal is fully visible and focusable
}

function closePaymentModal() {
    (document.getElementById('paymentModal')).classList.add('hidden');
}

function calculateChange() {
    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const cashPaid = parseInt((document.getElementById('cashPaidInput')).value) || 0;
    const difference = cashPaid - total;

    const changeLabelEl = document.getElementById('paymentChangeLabel');
    const changeValueEl = document.getElementById('paymentChange');
    const completeButton = document.getElementById('completeTransactionButton');

    if (difference >= 0) {
        changeLabelEl.textContent = 'Kembalian:';
        changeValueEl.textContent = `Rp ${formatCurrency(difference)}`;
        changeValueEl.classList.remove('text-red-500');
        changeValueEl.classList.add('text-green-500');
        completeButton.disabled = false;
    } else {
        changeLabelEl.textContent = 'Kurang:';
        changeValueEl.textContent = `Rp ${formatCurrency(Math.abs(difference))}`;
        changeValueEl.classList.remove('text-green-500');
        changeValueEl.classList.add('text-red-500');
        completeButton.disabled = true;
    }
}

function handleQuickCash(amount) {
    const cashPaidInput = document.getElementById('cashPaidInput');
    const currentAmount = parseInt(cashPaidInput.value) || 0;
    cashPaidInput.value = (currentAmount + amount).toString();
    calculateChange();
}

// Receipt Modal
async function showReceiptModal(transactionId, predefinedTransaction, isTest = false) {
    const transaction = predefinedTransaction || await getFromDB('transactions', transactionId);
    if (!transaction) return;

    // Fetch all settings
    const settings = await getAllFromDB('settings');
    const getSetting = (key, defaultValue) => {
        const setting = settings.find(s => s.key === key);
        return setting !== undefined ? setting.value : defaultValue;
    };

    const storeName = getSetting('storeName', 'Nama Toko Anda');
    const storeAddress = getSetting('storeAddress', 'Alamat Toko Anda');
    const feedbackPhone = getSetting('storeFeedbackPhone', '');
    const storeLogo = getSetting('storeLogo', null);
    const storeFooterText = getSetting('storeFooterText', 'Terima Kasih!');
    const autoPrint = getSetting('autoPrintReceipt', false);

    // --- Populate Modal ---
    
    // Logo
    const logoContainer = document.getElementById('receiptLogoContainer');
    if (storeLogo) {
        (document.getElementById('receiptLogo')).src = storeLogo;
        logoContainer.classList.remove('hidden');
    } else {
        logoContainer.classList.add('hidden');
    }
    
    // Header
    (document.getElementById('receiptStoreName')).textContent = storeName;
    (document.getElementById('receiptStoreAddress')).textContent = storeAddress;

    // Info
    (document.getElementById('receiptTransactionId')).textContent = transaction.id.toString().padStart(8, '0');
    (document.getElementById('receiptDate')).textContent = new Date(transaction.date).toLocaleString('id-ID');

    // Items
    (document.getElementById('receiptItems')).innerHTML = transaction.items.map(item => `
        <div class="flex justify-between">
            <span>${item.name} (${item.quantity}x)</span>
            <span>Rp ${formatCurrency(item.price * item.quantity)}</span>
        </div>
    `).join('');

    // Summary
    (document.getElementById('receiptTotal')).textContent = `Rp ${formatCurrency(transaction.total)}`;
    (document.getElementById('receiptCashPaid')).textContent = `Rp ${formatCurrency(transaction.cashPaid || 0)}`;
    (document.getElementById('receiptChange')).textContent = `Rp ${formatCurrency(transaction.change || 0)}`;

    // Footer
    let feedbackText = '';
    if (feedbackPhone) feedbackText += `Kritik&Saran:${feedbackPhone}`;
    (document.getElementById('receiptFeedback')).textContent = feedbackText;
    (document.getElementById('receiptCustomFooter')).textContent = storeFooterText;

    (document.getElementById('receiptModal')).classList.remove('hidden');
    
    const actionButton = document.getElementById('receiptActionButton');

    if (isTest) {
        actionButton.innerHTML = `<i class="fas fa-times mr-2"></i>Tutup`;
        actionButton.onclick = () => closeReceiptModal(false);
        // Print immediately for tests, with a short delay for rendering
        setTimeout(printReceipt, 300);
    } else {
        actionButton.innerHTML = `<i class="fas fa-plus-circle mr-2"></i>Transaksi Baru`;
        actionButton.onclick = () => closeReceiptModal(true);
        if (autoPrint) {
            setTimeout(printReceipt, 500); // Delay to allow modal to render fully
        }
    }
}

function closeReceiptModal(navigateToDashboard) {
    (document.getElementById('receiptModal')).classList.add('hidden');
    if (navigateToDashboard) {
        showPage('dashboard');
    }
}

function printReceipt() {
    window.print();
}

function testPrint() {
    const testTransaction = {
        id: 1234,
        date: new Date().toISOString(),
        items: [
            { id: 1, name: 'Item Tes 1', price: 10000, quantity: 1 },
            { id: 2, name: 'Item Tes 2', price: 5000, quantity: 2 },
        ],
        total: 20000,
        cashPaid: 50000,
        change: 30000,
    };
    // The transactionId `0` is a dummy value since we provide the transaction object directly.
    showReceiptModal(0, testTransaction, true);
}


// Print Help Modal
function showPrintHelpModal() {
    (document.getElementById('printHelpModal')).classList.remove('hidden');
}

function closePrintHelpModal() {
    (document.getElementById('printHelpModal')).classList.add('hidden');
}

// --- BARCODE SCANNER ---

// Function to play a beep sound on successful scan
function playBeep() {
    // Check for browser compatibility
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
        console.warn("Web Audio API is not supported in this browser.");
        return;
    }
    const audioCtx = new AudioContext();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    gainNode.gain.value = 0.1; // Keep volume low
    oscillator.frequency.value = 880; // A nice, clear frequency (A5)
    oscillator.type = 'sine'; // A clean tone

    oscillator.start();
    // Stop the sound after a short duration
    setTimeout(() => {
        oscillator.stop();
        audioCtx.close(); // Clean up the context
    }, 150);
}

function showScanModal() {
     if (typeof ZXing === 'undefined') {
        showToast('Gagal memuat pemindai barcode. Periksa koneksi internet Anda.');
        return;
    }
    codeReader = new ZXing.BrowserMultiFormatReader();
    const videoElement = document.getElementById('video');
    
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then(stream => {
            videoStream = stream;
            videoElement.srcObject = stream;
            (document.getElementById('scanModal')).classList.remove('hidden');
            codeReader.decodeFromStream(stream, videoElement, (result, err) => {
                if (result) {
                    playBeep();
                    if (navigator.vibrate) {
                        navigator.vibrate(150); // Short vibration
                    }
                    findProductByBarcode(result.getText());
                    closeScanModal();
                }
                if (err && !(err instanceof ZXing.NotFoundException)) {
                    console.error(err);
                }
            });
        })
        .catch(err => {
            console.error(err);
            showToast('Tidak dapat mengakses kamera');
        });
}

function closeScanModal() {
    if (codeReader) {
        codeReader.reset();
    }
    if (videoStream) {
        videoStream.getTracks().forEach(track => track.stop());
    }
    (document.getElementById('scanModal')).classList.add('hidden');
}

// --- SEARCH ---
function setupSearch() {
    const searchInput = document.getElementById('searchProduct');
    if (!searchInput) return;

    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const allProducts = document.querySelectorAll('#productsGrid .product-item');

        // If the search term is empty, it means the input was cleared or is empty.
        // In this case, we should show all products.
        if (searchTerm === '') {
            allProducts.forEach(item => {
                item.style.display = 'block';
            });
        } else {
            // Otherwise, filter the products based on the search term.
            allProducts.forEach(item => {
                const name = item.dataset.name || '';
                const category = item.dataset.category || '';
                const barcode = item.dataset.barcode || '';
                
                const isVisible = name.includes(searchTerm) || 
                                  category.includes(searchTerm) || 
                                  barcode.includes(searchTerm);
                
                item.style.display = isVisible ? 'block' : 'none';
            });
        }
    });

    searchInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            const barcode = e.target.value;
            if (barcode) {
                try {
                    const found = await findProductByBarcode(barcode);
                    if (found) {
                        // Clear input only if found
                        e.target.value = ''; 
                        // Manually trigger 'input' event to reset the visual filter
                        searchInput.dispatchEvent(new Event('input'));
                    }
                } catch (error) {
                    console.error("Error finding product by barcode:", error);
                }
            }
        }
    });
}

function findProductByBarcode(barcode) {
    return new Promise((resolve, reject) => {
        const trimmedBarcode = barcode.trim();
        if (!trimmedBarcode) {
            resolve(false);
            return;
        }
        const transaction = db.transaction(['products'], 'readonly');
        const store = transaction.objectStore('products');
        const index = store.index('barcode');
        const request = index.get(trimmedBarcode);
        
        request.onsuccess = (event) => {
            const product = event.target.result;
            if (product) {
                addToCart(product.id);
                resolve(true);
            } else {
                showToast(`Produk dengan barcode "${trimmedBarcode}" tidak ditemukan`);
                const searchInput = document.getElementById('searchProduct');
                if (searchInput) {
                    // Temporarily clear the search to trigger a filter reset, showing all products.
                    searchInput.value = '';
                    searchInput.dispatchEvent(new Event('input'));
                    // Then, populate the search bar with the unfound barcode for user reference.
                    searchInput.value = trimmedBarcode;
                }
                resolve(false);
            }
        };

        request.onerror = () => {
            showToast('Terjadi kesalahan saat mencari barcode');
            reject(new Error('Error searching for barcode'));
        };
    });
}


// --- INITIALIZATION ---
function setupCommonListeners() {
     // Setup confirmation modal buttons
    document.getElementById('cancelButton')?.addEventListener('click', closeConfirmationModal);
    document.getElementById('confirmButton')?.addEventListener('click', () => {
        if (confirmCallback) {
            confirmCallback();
        }
        closeConfirmationModal();
    });

    // Setup payment modal input
    document.getElementById('cashPaidInput')?.addEventListener('input', calculateChange);
    
    // Set default dates for report
    const today = new Date().toISOString().split('T')[0];
    (document.getElementById('dateFrom')).value = today;
    (document.getElementById('dateTo')).value = today;
}


window.addEventListener('load', () => {
    initDB().then(() => {
        setupCommonListeners();
        loadDashboard();
        loadProducts();
        loadStoreSettings();
        checkForRestore();
        setupSearch();
        runDailyBackupCheck();
    });
});

// Expose functions to global scope for onclick attributes
window.showPage = showPage;
window.handleNavClick = handleNavClick;
window.showAddProductModal = showAddProductModal;
window.closeAddProductModal = closeAddProductModal;
window.previewImage = previewImage;
window.addProduct = addProduct;
window.editProduct = editProduct;
window.deleteProduct = deleteProduct;
window.closeEditProductModal = closeEditProductModal;
window.previewEditImage = previewEditImage;
window.updateProduct = updateProduct;
window.addToCart = addToCart;
window.increaseQuantity = increaseQuantity;
window.decreaseQuantity = decreaseQuantity;
window.clearCart = clearCart;
window.showPaymentModal = showPaymentModal;
window.closePaymentModal = closePaymentModal;
window.handleQuickCash = handleQuickCash;
window.completeTransaction = completeTransaction;
window.printReceipt = printReceipt;
window.closeReceiptModal = closeReceiptModal;
window.generateReport = generateReport;
window.exportReportToCSV = exportReportToCSV;
window.deleteTransaction = deleteTransaction;
window.saveStoreSettings = saveStoreSettings;
window.previewStoreLogo = previewStoreLogo;
window.exportData = exportData;
window.importData = importData;
window.handleImport = handleImport;
window.clearAllData = clearAllData;
window.showScanModal = showScanModal;
window.closeScanModal = closeScanModal;
window.showPrintHelpModal = showPrintHelpModal;
window.closePrintHelpModal = closePrintHelpModal;
window.loadProductsList = loadProductsList; // Expose for onchange event
window.testPrint = testPrint;
window.showManageCategoryModal = showManageCategoryModal;
window.closeManageCategoryModal = closeManageCategoryModal;
window.addNewCategory = addNewCategory;
window.deleteCategory = deleteCategory;