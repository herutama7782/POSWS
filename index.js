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
let currentReceiptTransaction = null;
let isPrinterReady = false;
let isScannerReady = false;

// Bluetooth printing state
let bluetoothDevice = null;
let bluetoothCharacteristic = null;
let EscPosEncoder; // Will be initialized on load


// --- DATABASE FUNCTIONS ---
function initDB() {
    return new Promise((resolve, reject) => {
        // Graceful fallback for browsers that don't support IndexedDB
        if (!window.indexedDB) {
            console.error("IndexedDB could not be found in this browser.");
            const appContainer = document.getElementById('appContainer');
            if (appContainer) {
                appContainer.innerHTML = `
                    <div class="fixed inset-0 bg-gray-100 flex flex-col items-center justify-center p-8 text-center">
                        <i class="fas fa-exclamation-triangle text-5xl text-red-500 mb-4"></i>
                        <h1 class="text-2xl font-bold text-gray-800 mb-2">Browser Tidak Didukung</h1>
                        <p class="text-gray-600">
                            Aplikasi ini memerlukan fitur database modern (IndexedDB) yang tidak didukung oleh browser Anda.
                            Silakan gunakan browser modern seperti Chrome, Firefox, atau Safari.
                        </p>
                    </div>
                `;
            }
            reject("IndexedDB not supported");
            return;
        }

        const request = indexedDB.open('POS_DB', 7); 

        request.onerror = function(event) {
            console.error("Database error:", event.target.error);
            showToast('Gagal menginisialisasi database');
            reject(event.target.error);
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

            if (event.oldVersion < 6) {
                if (!db.objectStoreNames.contains('sync_queue')) {
                    db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
                }
            }
             if (event.oldVersion < 7) {
                if (!db.objectStoreNames.contains('fees')) {
                    db.createObjectStore('fees', { keyPath: 'id', autoIncrement: true });
                }

                // Migration logic: move PPN from settings to the new fees store
                const settingsStore = transaction.objectStore('settings');
                const feesStore = transaction.objectStore('fees');
                const ppnRequest = settingsStore.get('storePpn');

                ppnRequest.onsuccess = () => {
                    const ppnSetting = ppnRequest.result;
                    if (ppnSetting && ppnSetting.value > 0) {
                        const ppnFee = {
                            name: 'PPN',
                            type: 'percentage',
                            value: ppnSetting.value,
                            isDefault: true,
                            isTax: true,
                            createdAt: new Date().toISOString()
                        };
                        feesStore.add(ppnFee);
                        settingsStore.delete('storePpn');
                    }
                };
            }
        };
    });
}


function getFromDB(storeName, key) {
    return new Promise((resolve, reject) => {
        if (!db) {
            console.error('Database not initialized on getFromDB');
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
            console.error('Database not initialized on getAllFromDB');
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
            console.error('Database not initialized on putToDB');
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

// --- SERVER SYNC & OFFLINE HANDLING ---

function updateSyncStatusUI(status) {
    const syncIcon = document.getElementById('syncIcon');
    const syncText = document.getElementById('syncText');
    if (!syncIcon || !syncText) return;

    syncIcon.classList.remove('fa-spin', 'text-green-500', 'text-red-500', 'text-yellow-500');

    switch (status) {
        case 'syncing':
            syncIcon.className = 'fas fa-sync-alt fa-spin';
            syncText.textContent = 'Menyinkronkan...';
            break;
        case 'synced':
            syncIcon.className = 'fas fa-check-circle text-green-500';
            syncText.textContent = 'Terbaru';
            break;
        case 'offline':
            syncIcon.className = 'fas fa-wifi text-gray-400';
            syncText.textContent = 'Offline';
            break;
        case 'error':
            syncIcon.className = 'fas fa-exclamation-triangle text-red-500';
            syncText.textContent = 'Gagal sinkron';
            break;
        default:
            syncIcon.className = 'fas fa-sync-alt';
            syncText.textContent = 'Siap';
            break;
    }
}

async function checkOnlineStatus() {
    isOnline = navigator.onLine;
    if (isOnline) {
        updateSyncStatusUI('synced'); // Optimistically set to synced, syncWithServer will update if needed
        showToast('Kembali online, sinkronisasi data dimulai.', 2000);
        await window.syncWithServer();
    } else {
        updateSyncStatusUI('offline');
        showToast('Anda sekarang offline. Perubahan akan disimpan secara lokal.', 3000);
    }
}

async function queueSyncAction(action, payload) {
    try {
        await putToDB('sync_queue', { action, payload, timestamp: new Date().toISOString() });
        // Trigger sync immediately after queueing an action if online
        if (isOnline) {
            window.syncWithServer();
        }
    } catch (error) {
        console.error('Failed to queue sync action:', error);
        showToast('Gagal menyimpan perubahan untuk sinkronisasi.');
    }
}


window.syncWithServer = async function(isManual = false) {
    if (!isOnline) {
        if (isManual) showToast('Anda sedang offline. Sinkronisasi akan dilanjutkan saat kembali online.');
        updateSyncStatusUI('offline');
        return;
    }
    if (isSyncing) {
        if (isManual) showToast('Sinkronisasi sedang berjalan.');
        return;
    }

    isSyncing = true;
    updateSyncStatusUI('syncing');

    try {
        // --- 1. PUSH local changes to server ---
        const syncQueue = await getAllFromDB('sync_queue');
        if (syncQueue.length > 0) {
             if (isManual) showToast(`Mengirim ${syncQueue.length} perubahan ke server...`);

            for (const task of syncQueue) {
                console.log(`[SYNC] Processing: ${task.action}`, task.payload);
                // MOCK API CALL - In a real app, this would be a fetch() call
                const response = await new Promise(resolve => setTimeout(() => {
                    console.log(`[SYNC] Mock API call for ${task.action}`);
                    // Simulate success, potentially returning a server-generated ID
                    resolve({ success: true, serverId: `server_${Date.now()}`, localId: task.payload.id });
                }, 300)); // Simulate network latency

                if (response.success) {
                    // Update local item with server ID if applicable
                    if (task.action.startsWith('CREATE_') && response.serverId && response.localId) {
                        let storeName = '';
                        if (task.action.includes('PRODUCT')) storeName = 'products';
                        if (task.action.includes('CATEGORY')) storeName = 'categories';
                        if (task.action.includes('TRANSACTION')) storeName = 'transactions';
                        if (task.action.includes('FEE')) storeName = 'fees';

                        if (storeName) {
                            const item = await getFromDB(storeName, response.localId);
                            if (item) {
                                item.serverId = response.serverId;
                                await putToDB(storeName, item);
                            }
                        }
                    }
                    
                    // Remove successfully processed task from the queue
                    const tx = db.transaction('sync_queue', 'readwrite');
                    tx.objectStore('sync_queue').delete(task.id);
                } else {
                    // Handle API failure - leave task in queue and stop current sync process
                    console.error(`[SYNC] Failed to process task ${task.id}:`, response.error);
                    throw new Error(`API call failed for action: ${task.action}`);
                }
            }
        }

        // --- 2. PULL server changes to local (MOCKED) ---
        console.log("[SYNC] Mock fetching updates from server... (not implemented in this version)");
        // In a real app: fetch changes from server since last sync and update IndexedDB.


        // --- 3. Finalize ---
        await putSettingToDB({ key: 'lastSync', value: new Date().toISOString() });
        updateSyncStatusUI('synced');
         if (isManual) showToast('Sinkronisasi berhasil!');

    } catch (error) {
        console.error('Sync failed:', error);
        updateSyncStatusUI('error');
         if (isManual) showToast('Sinkronisasi gagal. Silakan coba lagi.');
    } finally {
        isSyncing = false;
        // Refresh UI with latest data
        if (currentPage === 'dashboard') loadDashboard();
        if (currentPage === 'produk') window.loadProductsList();
    }
}


// --- UI & NAVIGATION ---
let isNavigating = false; // Flag to prevent multiple clicks during transition

function updateFeatureAvailability() {
    // Scanner
    const scanBtn = document.getElementById('scanBarcodeBtn');
    if (scanBtn) {
        if (!isScannerReady) {
            scanBtn.disabled = true;
            scanBtn.classList.remove('bg-gray-600');
            scanBtn.classList.add('bg-gray-400', 'cursor-not-allowed');
            scanBtn.title = 'Pemindai barcode gagal dimuat.';
        } else {
            scanBtn.disabled = false;
            scanBtn.classList.add('bg-gray-600');
            scanBtn.classList.remove('bg-gray-400', 'cursor-not-allowed');
            scanBtn.title = '';
        }
    }

    // Printer
    const printReceiptBtn = document.getElementById('printReceiptBtn');
    const autoPrintContainer = document.getElementById('autoPrintContainer');
    const testPrintBtn = document.getElementById('testPrintBtn');

    if (!isPrinterReady) {
        if (printReceiptBtn) {
            printReceiptBtn.disabled = true;
            printReceiptBtn.classList.remove('bg-gray-600');
            printReceiptBtn.classList.add('bg-gray-400', 'cursor-not-allowed');
            printReceiptBtn.title = 'Fitur cetak gagal dimuat.';
        }
        if (testPrintBtn) {
            testPrintBtn.disabled = true;
            testPrintBtn.title = 'Fitur cetak gagal dimuat.';
        }
        if (autoPrintContainer) {
            autoPrintContainer.classList.add('opacity-50');
            const autoPrintCheckbox = document.getElementById('autoPrintReceipt');
            if (autoPrintCheckbox) autoPrintCheckbox.disabled = true;

            // Check if note already exists to prevent duplicates
            if (!autoPrintContainer.parentElement.querySelector('.library-error-note')) {
                const note = document.createElement('p');
                note.className = 'text-xs text-red-500 text-center mt-2 library-error-note';
                note.textContent = 'Fitur cetak tidak tersedia (library gagal dimuat).';
                autoPrintContainer.parentElement.insertBefore(note, autoPrintContainer.nextSibling);
            }
        }
    }
}


window.showPage = async function(pageName) {
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
        applyDefaultFees();
        updateCartDisplay();
    } else if (pageName === 'produk') {
        window.loadProductsList();
    } else if (pageName === 'pengaturan') {
        loadFees();
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
window.handleNavClick = function(button) {
    const pageName = button.dataset.page;
    if (pageName) {
        window.showPage(pageName);
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


window.showManageCategoryModal = async function() {
    (document.getElementById('manageCategoryModal')).classList.remove('hidden');
    await loadCategoriesForManagement();
}

window.closeManageCategoryModal = function() {
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

window.addNewCategory = async function() {
    const input = document.getElementById('newCategoryName');
    const name = input.value.trim();
    if (!name) {
        showToast('Nama kategori tidak boleh kosong');
        return;
    }
    try {
        const newCategory = { name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        const addedId = await putToDB('categories', newCategory);
        
        await queueSyncAction('CREATE_CATEGORY', { ...newCategory, id: addedId });
        showToast('Kategori berhasil ditambahkan');
        input.value = '';
        await loadCategoriesForManagement();
        await populateCategoryDropdowns(['productCategory', 'editProductCategory', 'productCategoryFilter']);
    } catch (error) {
        showToast('Gagal menambahkan. Kategori mungkin sudah ada.');
        console.error("Add category error:", error);
    }
}

window.deleteCategory = async function(id, name) {
    const products = await getAllFromDB('products');
    const isUsed = products.some(p => p.category === name);

    if (isUsed) {
        showToast(`Kategori "${name}" tidak dapat dihapus karena sedang digunakan oleh produk.`);
        return;
    }

    window.closeManageCategoryModal();

    showConfirmationModal(
        'Hapus Kategori',
        `Apakah Anda yakin ingin menghapus kategori "${name}"?`,
        async () => {
            const categoryToDelete = await getFromDB('categories', id);
            const transaction = db.transaction(['categories'], 'readwrite');
            const store = transaction.objectStore('categories');
            store.delete(id);
            transaction.oncomplete = async () => {
                await queueSyncAction('DELETE_CATEGORY', categoryToDelete);
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

            const hasDiscount = p.discountPercentage && p.discountPercentage > 0;
            const discountedPrice = hasDiscount ? p.price * (1 - p.discountPercentage / 100) : p.price;

            return `
            <div class="${itemClasses} relative" onclick="addToCart(${p.id})" data-name="${p.name.toLowerCase()}" data-category="${p.category ? p.category.toLowerCase() : ''}" data-barcode="${p.barcode || ''}">
                ${hasDiscount ? `<span class="absolute top-2 right-2 bg-red-500 text-white text-xs font-bold px-2 py-1 rounded-full z-10">-${p.discountPercentage}%</span>` : ''}
                ${p.image ? `<img src="${p.image}" alt="${p.name}" class="product-image">` : `<div class="bg-gray-100 rounded-lg p-4 mb-2"><i class="fas fa-box text-3xl text-gray-400"></i></div>`}
                <h3 class="font-semibold text-sm">${p.name}</h3>
                ${hasDiscount
                    ? `<div>
                         <p class="text-xs text-gray-500 line-through">Rp ${formatCurrency(p.price)}</p>
                         <p class="text-blue-500 font-bold">Rp ${formatCurrency(discountedPrice)}</p>
                       </div>`
                    : `<p class="text-blue-500 font-bold">Rp ${formatCurrency(p.price)}</p>`
                }
                <p class="text-xs text-gray-500">Stok: ${p.stock}${lowStockIndicator}</p>
            </div>
        `}).join('');
    });
}

window.loadProductsList = async function() {
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

            const hasDiscount = p.discountPercentage && p.discountPercentage > 0;
            const discountedPrice = hasDiscount ? p.price * (1 - p.discountPercentage / 100) : p.price;
            const discountBadge = hasDiscount ? `<span class="bg-red-100 text-red-700 text-xs font-semibold px-2 py-0.5 rounded-full">Diskon ${p.discountPercentage}%</span>` : '';

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
                                    ${hasDiscount
                                        ? `<p class="text-xs text-gray-400 line-through">Rp ${formatCurrency(p.price)}</p>
                                           <p class="text-blue-500 font-bold">Rp ${formatCurrency(discountedPrice)}</p>`
                                        : `<p class="text-blue-500 font-bold">Rp ${formatCurrency(p.price)}</p>`
                                    }
                                    <p class="text-xs text-gray-500">Beli: Rp ${formatCurrency(p.purchasePrice)}</p>
                                </div>
                                <div class="text-right flex items-center gap-2">
                                    ${discountBadge}
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
window.showAddProductModal = function() {
    (document.getElementById('addProductModal')).classList.remove('hidden');
    populateCategoryDropdowns(['productCategory']);
}

window.closeAddProductModal = function() {
    (document.getElementById('addProductModal')).classList.add('hidden');
    (document.getElementById('productName')).value = '';
    (document.getElementById('productPrice')).value = '';
    (document.getElementById('productPurchasePrice')).value = '';
    (document.getElementById('productStock')).value = '';
    (document.getElementById('productBarcode')).value = '';
    (document.getElementById('productCategory')).value = '';
    (document.getElementById('productDiscount')).value = '';
    (document.getElementById('imagePreview')).innerHTML = `<i class="fas fa-camera text-3xl mb-2"></i><p>Tap untuk upload gambar</p>`;
    currentImageData = null;
}

window.previewImage = function(event) {
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

window.addProduct = function() {
    const name = (document.getElementById('productName')).value;
    const price = parseInt((document.getElementById('productPrice')).value);
    const purchasePrice = parseInt((document.getElementById('productPurchasePrice')).value);
    const stock = parseInt((document.getElementById('productStock')).value);
    const category = (document.getElementById('productCategory')).value;
    const barcode = (document.getElementById('productBarcode')).value;
    const discount = parseFloat((document.getElementById('productDiscount')).value) || 0;

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
     if (discount < 0 || discount > 100) {
        showToast('Diskon harus antara 0 dan 100');
        return;
    }
    
    const now = new Date().toISOString();
    const newProduct = { name, price, purchasePrice, stock, category, barcode, image: currentImageData, discountPercentage: discount, createdAt: now, updatedAt: now };
    
    const transaction = db.transaction(['products'], 'readwrite');
    const store = transaction.objectStore('products');
    const request = store.add(newProduct);
    
    request.onsuccess = (event) => {
        const insertedId = event.target.result;
        queueSyncAction('CREATE_PRODUCT', { ...newProduct, id: insertedId });
        showToast('Produk berhasil ditambahkan');
        window.closeAddProductModal();
        window.loadProductsList();
        loadProductsGrid();
        loadDashboard();
    };
    request.onerror = () => {
        showToast('Gagal menambahkan produk. Barcode mungkin sudah ada.');
    }
}

// Edit Product Modal
window.editProduct = async function(id) {
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
        (document.getElementById('editProductDiscount')).value = product.discountPercentage || '';

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

window.closeEditProductModal = function() {
    (document.getElementById('editProductModal')).classList.add('hidden');
}

window.previewEditImage = function(event) {
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

window.updateProduct = async function() {
    const id = parseInt((document.getElementById('editProductId')).value);
    const name = (document.getElementById('editProductName')).value;
    const price = parseInt((document.getElementById('editProductPrice')).value);
    const purchasePrice = parseInt((document.getElementById('editProductPurchasePrice')).value);
    const stock = parseInt((document.getElementById('editProductStock')).value);
    const category = (document.getElementById('editProductCategory')).value;
    const barcode = (document.getElementById('editProductBarcode')).value;
    const discount = parseFloat((document.getElementById('editProductDiscount')).value) || 0;

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
    if (discount < 0 || discount > 100) {
        showToast('Diskon harus antara 0 dan 100');
        return;
    }
    
    const originalProduct = await getFromDB('products', id);
    const updatedProduct = { ...originalProduct, id, name, price, purchasePrice, stock, category, barcode, image: currentEditImageData, discountPercentage: discount, updatedAt: new Date().toISOString() };
    
    putToDB('products', updatedProduct).then(() => {
        queueSyncAction('UPDATE_PRODUCT', updatedProduct);
        showToast('Produk berhasil diperbarui');
        window.closeEditProductModal();
        window.loadProductsList();
        loadProductsGrid();
    }).catch(() => {
        showToast('Gagal memperbarui produk. Barcode mungkin sudah ada.');
    });
}

window.deleteProduct = function(id) {
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
                    queueSyncAction('DELETE_PRODUCT', product);
                    showToast('Produk berhasil dihapus');
                    window.loadProductsList();
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
    
    const subtotal = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    let total = subtotal;
    cart.fees.forEach(fee => {
        const feeAmount = fee.type === 'percentage' ? subtotal * (fee.value / 100) : fee.value;
        total += feeAmount;
    });

    (document.getElementById('paymentTotal')).textContent = `Rp ${formatCurrency(total)}`;
    
    calculateChange();
    
    const cashPaidInput = document.getElementById('cashPaidInput');
    cashPaidInput.focus();
    cashPaidInput.select();
}

window.addToCart = function(productId) {
    getFromDB('products', productId).then(product => {
        if (!product) {
            showToast('Produk tidak ditemukan');
            return;
        }
        if (product.stock <= 0) {
            showToast('Stok habis');
            return;
        }
        
        const existingItem = cart.items.find(item => item.id === productId);
        if (existingItem) {
            if (existingItem.quantity >= product.stock) {
                showToast('Stok tidak mencukupi');
                return;
            }
            existingItem.quantity++;
        } else {
            const discountPercentage = product.discountPercentage || 0;
            const discountedPrice = product.price * (1 - discountPercentage / 100);
            cart.items.push({ 
                id: product.id, 
                name: product.name, 
                price: discountedPrice, 
                originalPrice: product.price,
                discountPercentage: discountPercentage,
                quantity: 1 
            });
        }
        
        updateCartDisplay();
        refreshPaymentModalAndFocus();
        showToast(`${product.name} ditambahkan`);
    });
}

function updateCartDisplay() {
    const cartItemsEl = document.getElementById('cartItems');
    const cartSubtotalEl = document.getElementById('cartSubtotal');
    const cartFeesEl = document.getElementById('cartFees');
    const cartTotalEl = document.getElementById('cartTotal');
    
    if (cart.items.length === 0) {
        cartItemsEl.innerHTML = '<p class="text-gray-500 text-center py-4">Keranjang kosong</p>';
        cartSubtotalEl.textContent = 'Rp 0';
        cartFeesEl.innerHTML = '';
        cartTotalEl.textContent = 'Rp 0';
        return;
    }
    
    let subtotal = 0;
    cartItemsEl.innerHTML = cart.items.map(item => {
        const itemSubtotal = item.price * item.quantity;
        subtotal += itemSubtotal;
        const hasDiscount = item.discountPercentage && item.discountPercentage > 0;
        return `
            <div class="cart-item">
                <div class="flex justify-between items-center">
                    <div class="flex-1">
                        <h4 class="font-semibold">${item.name}</h4>
                        ${hasDiscount
                            ? `<div class="flex items-center gap-2">
                                  <p class="text-sm text-gray-600">Rp ${formatCurrency(item.price)} x ${item.quantity}</p>
                                  <span class="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-md">-${item.discountPercentage}%</span>
                               </div>
                               <p class="text-xs text-gray-400 line-through">Asli: Rp ${formatCurrency(item.originalPrice)}</p>`
                            : `<p class="text-sm text-gray-600">Rp ${formatCurrency(item.price)} x ${item.quantity}</p>`
                        }
                    </div>
                    <div class="flex items-center gap-2">
                        <button onclick="decreaseQuantity(${item.id})" class="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center clickable"><i class="fas fa-minus text-xs"></i></button>
                        <span>${item.quantity}</span>
                        <button onclick="increaseQuantity(${item.id})" class="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center clickable"><i class="fas fa-plus text-xs"></i></button>
                        <span class="font-semibold w-20 text-right">Rp ${formatCurrency(itemSubtotal)}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    let total = subtotal;
    cartFeesEl.innerHTML = '';

    cart.fees.forEach(fee => {
        const feeAmount = fee.type === 'percentage' ? subtotal * (fee.value / 100) : fee.value;
        total += feeAmount;
        cartFeesEl.innerHTML += `
            <div class="flex justify-between">
                <span>${fee.name} ${fee.type === 'percentage' ? `(${fee.value}%)` : ''}:</span>
                <span>Rp ${formatCurrency(feeAmount)}</span>
            </div>
        `;
    });
    
    cartSubtotalEl.textContent = `Rp ${formatCurrency(subtotal)}`;
    cartTotalEl.textContent = `Rp ${formatCurrency(total)}`;
}


window.increaseQuantity = function(productId) {
    getFromDB('products', productId).then(product => {
        if (!product) return;
        const cartItem = cart.items.find(item => item.id === productId);
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

window.decreaseQuantity = function(productId) {
    const cartItem = cart.items.find(item => item.id === productId);
    if (cartItem) {
        if (cartItem.quantity > 1) {
            cartItem.quantity--;
        } else {
            cart.items = cart.items.filter(item => item.id !== productId);
        }
        updateCartDisplay();
        refreshPaymentModalAndFocus();
    }
}

window.clearCart = async function() {
    if (cart.items.length === 0) return;
    showConfirmationModal(
        'Kosongkan Keranjang',
        'Apakah Anda yakin ingin mengosongkan keranjang?',
        async () => {
            cart.items = [];
            cart.fees = [];
            await applyDefaultFees();
            updateCartDisplay();
            showToast('Keranjang dikosongkan');
        },
        'Ya, Kosongkan',
        'bg-red-500'
    );
}

window.completeTransaction = function() {
    if (cart.items.length === 0) {
        showToast('Keranjang kosong');
        return;
    }

    const subtotal = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    let total = subtotal;
    const appliedFees = cart.fees.map(fee => {
        const amount = fee.type === 'percentage' ? subtotal * (fee.value / 100) : fee.value;
        total += amount;
        return { ...fee, amount };
    });

    const cashPaid = parseInt(document.getElementById('cashPaidInput').value) || 0;
    const change = cashPaid - total;

    if (cashPaid < total) {
        showToast('Uang yang dibayarkan tidak cukup');
        return;
    }

    const completeButton = document.getElementById('completeTransactionButton');
    if (completeButton) {
        const buttonText = completeButton.querySelector('.payment-button-text');
        const buttonSpinner = completeButton.querySelector('.payment-button-spinner');
        completeButton.disabled = true;
        buttonText?.classList.add('hidden');
        buttonSpinner?.classList.remove('hidden');
    }

    window.closePaymentModal();

    setTimeout(() => {
        const transaction = db.transaction(['transactions', 'products'], 'readwrite');
        const transactionStore = transaction.objectStore('transactions');
        const productStore = transaction.objectStore('products');

        const newTransaction = {
            date: new Date().toISOString(),
            items: [...cart.items],
            fees: appliedFees,
            subtotal,
            total,
            cashPaid,
            change,
        };

        const request = transactionStore.add(newTransaction);

        request.onsuccess = (event) => {
            const transactionId = event.target.result;
            queueSyncAction('CREATE_TRANSACTION', { ...newTransaction, id: transactionId });

            cart.items.forEach(item => {
                productStore.get(item.id).onsuccess = (event) => {
                    const product = event.target.result;
                    if (product) {
                        product.stock -= item.quantity;
                        product.updatedAt = new Date().toISOString();
                        const updateReq = productStore.put(product);
                        updateReq.onsuccess = () => {
                            queueSyncAction('UPDATE_PRODUCT_STOCK', { id: product.id, serverId: product.serverId, newStock: product.stock });
                        }
                    }
                };
            });

            cart.items = [];
            cart.fees = [];
            applyDefaultFees();
            showReceiptModal(transactionId, undefined, false);
        };
        request.onerror = () => {
            showToast('Gagal menyelesaikan transaksi.');
        };
    }, 200);
}



// --- REPORTS ---
window.generateReport = function() {
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
        
        currentReportData = filtered;

        const totalSales = filtered.reduce((sum, t) => sum + t.total, 0);
        let totalTax = 0;
        let totalFees = 0;
        filtered.forEach(t => {
            (t.fees || []).forEach(f => {
                if(f.isTax) {
                    totalTax += f.amount;
                } else {
                    totalFees += f.amount;
                }
            });
        });

        const totalTransactions = filtered.length;
        const average = totalTransactions > 0 ? totalSales / totalTransactions : 0;
        
        (document.getElementById('reportTotalSales')).textContent = `Rp ${formatCurrency(totalSales)}`;
        (document.getElementById('reportTotalTax')).textContent = `Rp ${formatCurrency(totalTax)}`;
        (document.getElementById('reportTotalFees')).textContent = `Rp ${formatCurrency(totalFees)}`;
        (document.getElementById('reportTotalTransactions')).textContent = totalTransactions.toString();
        (document.getElementById('reportAverage')).textContent = `Rp ${formatCurrency(average)}`;
        
        displayReportTransactions(filtered);

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

window.deleteTransaction = function(id) {
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

                transactionStore.delete(id);
                queueSyncAction('DELETE_TRANSACTION', transactionToDelete);

                transactionToDelete.items.forEach(item => {
                    const getRequest = productStore.get(item.id);
                    getRequest.onsuccess = () => {
                        const product = getRequest.result;
                        if (product) {
                            product.stock += item.quantity;
                            product.updatedAt = new Date().toISOString();
                            const updateReq = productStore.put(product);
                            updateReq.onsuccess = () => {
                                queueSyncAction('UPDATE_PRODUCT_STOCK', { id: product.id, serverId: product.serverId, newStock: product.stock });
                            }
                        }
                    };
                });

                tx.oncomplete = () => {
                    showToast(`Transaksi #${id} berhasil dihapus.`);
                    window.generateReport();
                    loadDashboard();
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

window.exportReportToCSV = async function() {
    if (currentReportData.length === 0) {
        showToast('Tidak ada data laporan untuk diexport');
        return;
    }

    showToast('Mempersiapkan file CSV...', 2000);

    try {
        const headers = [
            'ID Transaksi', 'Tanggal', 'Waktu', 'Subtotal', 'Total Pajak', 'Total Biaya Lain', 'Total Akhir', 'Detail Biaya'
        ];

        const rows = currentReportData.map(t => {
            const transactionDate = new Date(t.date);
            const date = transactionDate.toLocaleDateString('id-ID', { year: 'numeric', month: '2-digit', day: '2-digit' });
            const time = transactionDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

            let totalTax = 0;
            let totalOtherFees = 0;
            const feeDetails = (t.fees || []).map(f => {
                if (f.isTax) {
                    totalTax += f.amount;
                } else {
                    totalOtherFees += f.amount;
                }
                return `${f.name}: ${formatCurrency(f.amount)}`;
            }).join('; ');

            return [
                t.id,
                date,
                time,
                t.subtotal,
                totalTax,
                totalOtherFees,
                t.total,
                feeDetails
            ];
        });

        const csvContent = convertToCSV(rows, headers);
        const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
        
        const dateFrom = (document.getElementById('dateFrom')).value;
        const dateTo = (document.getElementById('dateTo')).value;
        const filename = `Laporan_Transaksi_${dateFrom}_sampai_${dateTo}.csv`;

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
    // This function is now less critical as we use ESC/POS, but we keep it for the modal preview.
    const styleEl = document.getElementById('print-style-overrides');
    if (!styleEl) return;
    
    // We remove the @page styles as they are for browser printing.
    // We only control the font size for the on-screen receipt modal.
    let css = '';
    if (paperSize === '58mm') {
        css = `#receiptContent { font-size: 11px; }`;
    } else { // Default to 80mm
        css = `#receiptContent { font-size: 12px; }`;
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
    loadFees();
}

window.saveStoreSettings = async function() {
    const settings = {
        storeName: document.getElementById('storeName').value,
        storeAddress: document.getElementById('storeAddress').value,
        storeFeedbackPhone: document.getElementById('storeFeedbackPhone').value,
        storeFooterText: document.getElementById('storeFooterText').value,
        lowStockThreshold: parseInt(document.getElementById('lowStockThreshold').value) || 5,
        storeLogo: currentStoreLogoData,
        autoPrintReceipt: document.getElementById('autoPrintReceipt').checked,
        printerPaperSize: document.getElementById('printerPaperSize').value
    };

    updatePrintStyles(settings.printerPaperSize);
    lowStockThreshold = settings.lowStockThreshold;

    const promises = Object.entries(settings).map(([key, value]) => 
        putSettingToDB({ key, value })
    );
    
    await Promise.all(promises);
    
    await queueSyncAction('UPDATE_SETTINGS', settings);

    showToast('Pengaturan berhasil disimpan');
    loadDashboard();
    loadProductsGrid();
    window.loadProductsList();
}


window.previewStoreLogo = function(event) {
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
window.exportData = function() {
    Promise.all([
        getAllFromDB('products'),
        getAllFromDB('transactions'),
        getAllFromDB('settings'),
        getAllFromDB('categories'),
        getAllFromDB('fees')
    ]).then(([products, transactions, settingsArray, categories, fees]) => {
        const settings = {};
        settingsArray.forEach(s => settings[s.key] = s.value);
        
        const data = {
            products,
            transactions,
            settings,
            categories,
            fees,
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

window.importData = function() {
    (document.getElementById('importFile')).click();
}

window.handleImport = function(event) {
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
                    const storesToClear = ['products', 'transactions', 'settings', 'categories', 'sync_queue', 'fees'];
                    const clearTransaction = db.transaction(storesToClear, 'readwrite');
                    storesToClear.forEach(store => clearTransaction.objectStore(store).clear());
                    
                    clearTransaction.oncomplete = () => {
                        const importTransaction = db.transaction(storesToClear, 'readwrite');
                        if (data.products) data.products.forEach(p => importTransaction.objectStore('products').add(p));
                        if (data.transactions) data.transactions.forEach(t => importTransaction.objectStore('transactions').add(t));
                        if (data.settings) Object.keys(data.settings).forEach(key => importTransaction.objectStore('settings').add({ key, value: data.settings[key] }));
                        if (data.categories) data.categories.forEach(c => importTransaction.objectStore('categories').add(c));
                        if (data.fees) data.fees.forEach(f => importTransaction.objectStore('fees').add(f));
                        
                        importTransaction.oncomplete = () => {
                            showToast('Data berhasil diimpor. Sinkronisasi data baru dimulai.');
                            window.syncWithServer(true); // Sync all imported data
                            loadDashboard();
                            window.loadProductsList();
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


window.clearAllData = function() {
    showConfirmationModal(
        'Hapus Semua Data',
        'APAKAH ANDA YAKIN? Semua data (produk, kategori, transaksi, dll) akan dihapus permanen. Tindakan ini tidak dapat dibatalkan.',
        () => {
            const storesToClear = ['products', 'transactions', 'settings', 'auto_backup', 'categories', 'sync_queue', 'fees'];
            const transaction = db.transaction(storesToClear, 'readwrite');
            storesToClear.forEach(store => transaction.objectStore(store).clear());

            transaction.oncomplete = () => {
                cart.items = [];
                cart.fees = [];
                updateCartDisplay();
                showToast('Semua data berhasil dihapus');
                queueSyncAction('CLEAR_ALL_DATA', { timestamp: new Date().toISOString() });
                loadDashboard();
                window.loadProductsList();
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
            window.loadProductsList();
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
window.showPaymentModal = function() {
    if (cart.items.length === 0) {
        showToast('Keranjang kosong');
        return;
    }
    
    const completeButton = document.getElementById('completeTransactionButton');
    if (completeButton) {
        const buttonText = completeButton.querySelector('.payment-button-text');
        const buttonSpinner = completeButton.querySelector('.payment-button-spinner');
        
        completeButton.disabled = true;
        buttonText?.classList.remove('hidden');
        buttonSpinner?.classList.add('hidden');
    }

    const subtotal = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    let total = subtotal;
    cart.fees.forEach(fee => {
        const feeAmount = fee.type === 'percentage' ? subtotal * (fee.value / 100) : fee.value;
        total += feeAmount;
    });

    const cashPaidInput = document.getElementById('cashPaidInput');
    (document.getElementById('paymentTotal')).textContent = `Rp ${formatCurrency(total)}`;
    cashPaidInput.value = '';
    
    calculateChange();
    
    (document.getElementById('paymentModal')).classList.remove('hidden');

    setTimeout(() => {
        cashPaidInput.focus();
    }, 100);
}

window.closePaymentModal = function() {
    (document.getElementById('paymentModal')).classList.add('hidden');
}

function calculateChange() {
    const subtotal = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    let total = subtotal;
    cart.fees.forEach(fee => {
        const feeAmount = fee.type === 'percentage' ? subtotal * (fee.value / 100) : fee.value;
        total += feeAmount;
    });

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

window.handleQuickCash = function(amount) {
    const cashPaidInput = document.getElementById('cashPaidInput');
    const currentAmount = parseInt(cashPaidInput.value) || 0;
    cashPaidInput.value = (currentAmount + amount).toString();
    calculateChange();
}

// Receipt Modal
async function showReceiptModal(transactionId, predefinedTransaction, isTest = false) {
    const transaction = predefinedTransaction || await getFromDB('transactions', transactionId);
    if (!transaction) return;
    currentReceiptTransaction = transaction;

    // --- 1. Fetch all settings at once ---
    const settings = await getAllFromDB('settings');
    const getSetting = (key, defaultValue) => {
        const setting = settings.find(s => s.key === key);
        return setting !== undefined ? setting.value : defaultValue;
    };

    const storeName = getSetting('storeName', 'NAMA TOKO ANDA');
    const storeAddress = getSetting('storeAddress', 'Alamat Toko Anda');
    const feedbackPhone = getSetting('storeFeedbackPhone', '');
    const paperSize = getSetting('printerPaperSize', '80mm');
    const autoPrint = getSetting('autoPrintReceipt', false);
    const storeLogo = getSetting('storeLogo', null);
    const storeFooterText = getSetting('storeFooterText', 'Terima Kasih!');

    // --- 2. Prepare receipt content dynamically ---
    const is58mm = paperSize === '58mm';
    const divider = '-'.repeat(is58mm ? 32 : 42);

    // --- Header ---
    let headerHtml = `<div class="text-center mb-2">`;
    if (storeLogo) {
        headerHtml += `<div id="receiptLogoContainer" class="mb-2"><img id="receiptLogo" src="${storeLogo}" class="mx-auto max-h-20"></div>`;
    }
    headerHtml += `<h2 class="font-bold text-base">${storeName.toUpperCase()}</h2><p class="text-xs">${storeAddress}</p></div>`;

    // --- Info ---
    const date = new Date(transaction.date);
    const formattedDate = `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear()}`;
    const formattedTime = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    const infoHtml = `
        <div class="text-xs">
            <div class="flex justify-between"><span>Bon:</span><span>${transaction.id.toString().padStart(8, '0')}</span></div>
            <div class="flex justify-between"><span>Tanggal:</span><span>${formattedDate} ${formattedTime}</span></div>
        </div>`;

    // --- Items ---
    const itemsHtml = transaction.items.map(item => {
        const hasDiscount = item.discountPercentage && item.discountPercentage > 0;
        if (hasDiscount) {
            return `
            <div class="text-xs leading-tight py-1">
                <div>${item.name}</div>
                <div class="flex justify-between"><span class="pl-2">${item.quantity} x ${formatCurrency(item.originalPrice)}</span><span>${formatCurrency(item.originalPrice * item.quantity)}</span></div>
                <div class="flex justify-between"><span class="pl-2">Diskon (${item.discountPercentage}%)</span><span>-${formatCurrency((item.originalPrice - item.price) * item.quantity)}</span></div>
            </div>`;
        } else {
            return `
            <div class="text-xs leading-tight py-1">
                <div>${item.name}</div>
                <div class="flex justify-between"><span class="pl-2">${item.quantity} x ${formatCurrency(item.price)}</span><span>${formatCurrency(item.price * item.quantity)}</span></div>
            </div>`;
        }
    }).join('');

    // --- Summary ---
    const subtotal = transaction.subtotal || transaction.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const feesHtml = (transaction.fees || []).map(fee => `<div class="flex justify-between"><span>${fee.name} ${fee.type === 'percentage' ? `(${fee.value}%)` : ''}</span><span>${formatCurrency(fee.amount)}</span></div>`).join('');
    const summaryHtml = `
        <div class="text-xs my-2 space-y-1">
            <div class="flex justify-between"><span>Subtotal</span><span>${formatCurrency(subtotal)}</span></div>
            ${feesHtml}
            <div class="flex justify-between font-bold border-t border-dashed border-black mt-1 pt-1"><span>TOTAL</span><span>${formatCurrency(transaction.total)}</span></div>
            <div class="border-t border-dashed border-black my-1"></div>
            <div class="flex justify-between"><span>Tunai</span><span>${formatCurrency(transaction.cashPaid || 0)}</span></div>
            <div class="flex justify-between"><span>Kembalian</span><span>${formatCurrency(transaction.change || 0)}</span></div>
        </div>`;

    // --- Footer ---
    let footerHtml = `<div class="receipt-footer text-center text-xs mt-2">`;
    if (feedbackPhone) footerHtml += `<p>Kritik & Saran: ${feedbackPhone}</p>`;
    footerHtml += `<p>${storeFooterText}</p></div>`;

    // --- 3. Render to DOM ---
    const receiptContainer = document.getElementById('receiptContent');
    receiptContainer.innerHTML = `
        ${headerHtml}
        <div class="text-center">${divider}</div>
        ${infoHtml}
        <div class="text-center">${divider}</div>
        ${itemsHtml}
        <div class="text-center">${divider}</div>
        ${summaryHtml}
        <div class="text-center">${divider}</div>
        ${footerHtml}
    `;

    // --- 4. Show modal and handle actions ---
    document.getElementById('receiptModal').classList.remove('hidden');
    const actionButton = document.getElementById('receiptActionButton');
    if (isTest) {
        actionButton.innerHTML = `<i class="fas fa-times mr-2"></i>Tutup`;
        actionButton.onclick = () => window.closeReceiptModal(false);
    } else {
        actionButton.innerHTML = `<i class="fas fa-plus-circle mr-2"></i>Transaksi Baru`;
        actionButton.onclick = () => window.closeReceiptModal(true);
        if (autoPrint) {
            setTimeout(window.printReceipt, 500);
        }
    }
}

window.closeReceiptModal = function(navigateToDashboard) {
    (document.getElementById('receiptModal')).classList.add('hidden');
    currentReceiptTransaction = null; // Clear the transaction cache
    if (navigateToDashboard) {
        window.showPage('dashboard');
    }
}

// Print Help Modal
window.showPrintHelpModal = function() {
    (document.getElementById('printHelpModal')).classList.remove('hidden');
}

window.closePrintHelpModal = function() {
    (document.getElementById('printHelpModal')).classList.add('hidden');
}

// --- BARCODE SCANNER ---
function playBeep() {
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

    gainNode.gain.value = 0.1;
    oscillator.frequency.value = 880;
    oscillator.type = 'sine';

    oscillator.start();
    setTimeout(() => {
        oscillator.stop();
        audioCtx.close();
    }, 150);
}

window.showScanModal = function() {
    if (!isScannerReady) {
        showToast('Fitur pemindai tidak tersedia (library gagal dimuat).');
        console.error('Attempted to use scanner, but scanner library is not ready.');
        return;
    }

    document.getElementById('scanModal').classList.remove('hidden');

    const onScanSuccess = async (decodedText, decodedResult) => {
        playBeep();
        if (navigator.vibrate) {
            navigator.vibrate(150);
        }
        await window.closeScanModal();
        try {
            await findProductByBarcode(decodedText);
        } catch (error) {
            console.error("Error processing barcode after successful scan:", error);
        }
    };
    
    const config = { fps: 10, qrbox: { width: 250, height: 250 } };

    html5QrCode.start({ facingMode: "environment" }, config, onScanSuccess, (e)=>{})
        .catch((err) => {
            html5QrCode.start({ }, config, onScanSuccess, (e)=>{})
                .catch((finalErr) => {
                    console.error("Failed to start scanner with any camera:", finalErr);
                    showToast('Gagal memulai kamera. Pastikan izin telah diberikan.');
                    window.closeScanModal();
                });
        });
}


window.closeScanModal = async function() {
    const modal = document.getElementById('scanModal');
    if (modal) {
        modal.classList.add('hidden');
    }

    if (html5QrCode && html5QrCode.isScanning) {
        try {
            await html5QrCode.stop();
        } catch (err) {
            console.warn("Error stopping the scanner, it might have already been stopped:", err);
        }
    }
}


// --- SEARCH ---
function setupSearch() {
    const searchInput = document.getElementById('searchProduct');
    if (!searchInput) return;

    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const allProducts = document.querySelectorAll('#productsGrid .product-item');

        if (searchTerm === '') {
            allProducts.forEach(item => {
                item.style.display = 'block';
            });
        } else {
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
                        e.target.value = ''; 
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
                window.addToCart(product.id);
                resolve(true);
            } else {
                showToast(`Produk dengan barcode "${trimmedBarcode}" tidak ditemukan`);
                const searchInput = document.getElementById('searchProduct');
                if (searchInput) {
                    searchInput.value = '';
                    searchInput.dispatchEvent(new Event('input'));
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

// --- TAX & FEE MANAGEMENT ---
async function loadFees() {
    const listEl = document.getElementById('feesList');
    if (!listEl) return;
    const fees = await getAllFromDB('fees');
    fees.sort((a, b) => a.name.localeCompare(b.name));

    if (fees.length === 0) {
        listEl.innerHTML = `<p class="text-gray-500 text-center py-4">Belum ada pajak atau biaya tambahan.</p>`;
        return;
    }
    listEl.innerHTML = fees.map(fee => `
        <div class="flex justify-between items-center bg-gray-100 p-2 rounded-lg">
            <div>
                <p class="font-semibold">${fee.name}</p>
                <p class="text-sm text-gray-600">
                    ${fee.type === 'percentage' ? `${fee.value}%` : `Rp ${formatCurrency(fee.value)}`}
                    ${fee.isDefault ? '<span class="text-xs text-blue-500 ml-2">(Otomatis)</span>' : ''}
                </p>
            </div>
            <button onclick="deleteFee(${fee.id})" class="text-red-500 clickable"><i class="fas fa-trash"></i></button>
        </div>
    `).join('');
}

window.addFee = async function() {
    const name = document.getElementById('feeName').value.trim();
    const type = document.getElementById('feeType').value;
    const value = parseFloat(document.getElementById('feeValue').value);
    const isDefault = document.getElementById('feeIsDefault').checked;

    if (!name || isNaN(value) || value < 0) {
        showToast('Nama dan nilai biaya harus diisi dengan benar.');
        return;
    }

    const isTax = name.toLowerCase().includes('pajak') || name.toLowerCase().includes('ppn');

    const newFee = { name, type, value, isDefault, isTax, createdAt: new Date().toISOString() };
    
    try {
        const addedId = await putToDB('fees', newFee);
        await queueSyncAction('CREATE_FEE', { ...newFee, id: addedId });
        showToast('Biaya berhasil ditambahkan.');
        
        document.getElementById('feeName').value = '';
        document.getElementById('feeValue').value = '';
        document.getElementById('feeIsDefault').checked = false;
        
        loadFees();
    } catch (error) {
        showToast('Gagal menambahkan biaya.');
        console.error("Add fee error:", error);
    }
}

window.deleteFee = function(id) {
    showConfirmationModal('Hapus Biaya', 'Anda yakin ingin menghapus biaya ini?', async () => {
        const feeToDelete = await getFromDB('fees', id);
        const tx = db.transaction('fees', 'readwrite');
        tx.objectStore('fees').delete(id);
        tx.oncomplete = async () => {
            await queueSyncAction('DELETE_FEE', feeToDelete);
            showToast('Biaya berhasil dihapus.');
            loadFees();
        };
    }, 'Ya, Hapus', 'bg-red-500');
}

async function applyDefaultFees() {
    try {
        const allFees = await getAllFromDB('fees');
        cart.fees = allFees.filter(f => f.isDefault).map(f => ({ ...f }));
    } catch (error) {
        console.error("Failed to apply default fees:", error);
    }
}


window.showFeeSelectionModal = async function() {
    const modal = document.getElementById('feeSelectionModal');
    const listEl = document.getElementById('feeSelectionList');
    if (!modal || !listEl) return;

    const allFees = await getAllFromDB('fees');
    if (allFees.length === 0) {
        showToast('Tidak ada pajak atau biaya yang dikonfigurasi di Pengaturan.');
        return;
    }

    listEl.innerHTML = allFees.map(fee => {
        const isApplied = cart.fees.some(cartFee => cartFee.id === fee.id);
        return `
            <div class="flex justify-between items-center p-2 rounded-lg hover:bg-gray-100">
                <label for="fee-checkbox-${fee.id}" class="flex-1 cursor-pointer">
                    <p class="font-semibold">${fee.name}</p>
                    <p class="text-sm text-gray-500">${fee.type === 'percentage' ? `${fee.value}%` : `Rp ${formatCurrency(fee.value)}`}</p>
                </label>
                <input type="checkbox" id="fee-checkbox-${fee.id}" data-fee-id="${fee.id}" class="h-5 w-5 rounded text-blue-500 focus:ring-blue-400" ${isApplied ? 'checked' : ''}>
            </div>
        `;
    }).join('');

    modal.classList.remove('hidden');
}

window.closeFeeSelectionModal = function() {
    document.getElementById('feeSelectionModal').classList.add('hidden');
}

window.applySelectedFees = async function() {
    const allFees = await getAllFromDB('fees');
    const newCartFees = [];

    allFees.forEach(fee => {
        const checkbox = document.getElementById(`fee-checkbox-${fee.id}`);
        if (checkbox && checkbox.checked) {
            newCartFees.push({ ...fee });
        }
    });

    cart.fees = newCartFees;
    updateCartDisplay();
    window.closeFeeSelectionModal();
}

// --- BLUETOOTH PRINTING ---
function updateBluetoothStatusUI() {
    const statusEl = document.getElementById('bluetoothStatus');
    const connectBtn = document.getElementById('connectBluetoothBtn');
    const disconnectBtn = document.getElementById('disconnectBluetoothBtn');
    const testPrintBtn = document.getElementById('testPrintBtn');

    if (!statusEl || !connectBtn || !disconnectBtn || !testPrintBtn) return;

    if (bluetoothDevice && bluetoothDevice.gatt.connected) {
        statusEl.innerHTML = `Terhubung ke: <strong class="text-green-600">${bluetoothDevice.name}</strong>`;
        connectBtn.classList.add('hidden');
        disconnectBtn.classList.remove('hidden');
        if (isPrinterReady) testPrintBtn.disabled = false;
    } else {
        statusEl.innerHTML = 'Status: <span class="text-red-500">Belum Terhubung</span>';
        connectBtn.classList.remove('hidden');
        disconnectBtn.classList.add('hidden');
        testPrintBtn.disabled = true;
        bluetoothDevice = null;
        bluetoothCharacteristic = null;
    }
}

function onBluetoothDisconnected() {
    showToast(`Printer ${bluetoothDevice ? bluetoothDevice.name : ''} terputus.`);
    updateBluetoothStatusUI();
}

window.disconnectBluetoothPrinter = function() {
    if (bluetoothDevice && bluetoothDevice.gatt.connected) {
        bluetoothDevice.gatt.disconnect();
    }
}

window.connectToBluetoothPrinter = async function() {
    if (!navigator.bluetooth) {
        showToast('Web Bluetooth tidak didukung di browser ini.');
        return;
    }

    try {
        showToast('Mencari printer Bluetooth...', 2000);
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: ['00001101-0000-1000-8000-00805f9b34fb'] }], // Serial Port Profile
        });

        showToast(`Menghubungkan ke ${device.name}...`, 2000);
        
        device.addEventListener('gattserverdisconnected', onBluetoothDisconnected);
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService('00001101-0000-1000-8000-00805f9b34fb');
        const characteristics = await service.getCharacteristics();
        
        let writableCharacteristic = null;
        for (const char of characteristics) {
            if (char.properties.write || char.properties.writeWithoutResponse) {
                writableCharacteristic = char;
                break;
            }
        }

        if (!writableCharacteristic) {
            throw new Error('Tidak ada characteristic yang bisa ditulis ditemukan.');
        }

        bluetoothDevice = device;
        bluetoothCharacteristic = writableCharacteristic;
        
        showToast(`Berhasil terhubung ke ${device.name}`);
        updateBluetoothStatusUI();

    } catch (error) {
        let userMessage = `Gagal terhubung: ${error.message}`;

        if (error.name === 'NotFoundError') {
            userMessage = 'Tidak ada printer yang dipilih.';
            console.log('Koneksi Bluetooth gagal: User membatalkan pilihan perangkat.');
        } else {
            console.error('Koneksi Bluetooth gagal:', error);
            if (error.name === 'NotAllowedError') {
                 userMessage = 'Akses Bluetooth tidak diizinkan. Periksa pengaturan browser.';
            }
        }
        
        showToast(userMessage, 5000);
        updateBluetoothStatusUI();
    }
}

async function sendDataToBluetoothPrinter(data) {
    if (!bluetoothDevice || !bluetoothDevice.gatt.connected || !bluetoothCharacteristic) {
        showToast('Printer tidak terhubung.');
        return false;
    }

    try {
        const chunkSize = 512;
        for (let i = 0; i < data.length; i += chunkSize) {
            const chunk = data.subarray(i, i + chunkSize);
            await bluetoothCharacteristic.writeValueWithoutResponse(chunk);
        }
        return true;
    } catch (error) {
        console.error('Gagal mengirim data ke printer:', error);
        showToast(`Gagal mencetak: ${error.message}`);
        return false;
    }
}

window.printReceipt = async function() {
    if (!isPrinterReady) {
        showToast('Fitur cetak tidak tersedia (library gagal dimuat).');
        console.error("printReceipt called but printer library is not ready.");
        return;
    }
    if (!bluetoothDevice || !bluetoothDevice.gatt.connected) {
        showToast('Printer tidak terhubung. Silakan hubungkan di Pengaturan.');
        showPrintHelpModal();
        return;
    }
    if (!currentReceiptTransaction) {
        showToast("Data transaksi tidak ditemukan untuk dicetak.");
        return;
    }

    showToast('Mempersiapkan struk...');
    const encoder = new EscPosEncoder();
    encoder.initialize();

    const paperSize = (await getSettingFromDB('printerPaperSize')) || '80mm';
    const width = paperSize === '58mm' ? 32 : 42;
    const divider = '-'.repeat(width);

    const storeName = (await getSettingFromDB('storeName', 'NAMA TOKO ANDA')).toUpperCase();
    const storeAddress = await getSettingFromDB('storeAddress', 'Alamat Toko Anda');
    const storeLogoData = await getSettingFromDB('storeLogo', null);

    if (storeLogoData) {
        try {
            const image = await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = storeLogoData;
            });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = image.width;
            canvas.height = image.height;
            context.drawImage(image, 0, 0);
            const imageData = context.getImageData(0, 0, image.width, image.height);
            const imageDensity = paperSize === '58mm' ? 384 : 576;
            encoder.align('center').image(imageData, imageDensity);
        } catch (e) { console.error("Gagal memproses logo:", e); }
    }

    encoder.align('center').bold(true).text(storeName).bold(false).newline().text(storeAddress).newline().text(divider).newline();

    const t = currentReceiptTransaction;
    const date = new Date(t.date);
    const fDate = `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear()}`;
    const fTime = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;

    encoder.align('left').text(`Bon:`.padEnd(10) + `${t.id.toString().padStart(8, '0')}`).newline().text(`Tanggal:`.padEnd(10) + `${fDate} ${fTime}`).newline().text(divider).newline();

    t.items.forEach(item => {
        encoder.text(item.name).newline();
        const priceLine = ` ${item.quantity} x ${formatCurrency(item.price)}`;
        const totalLine = `${formatCurrency(item.price * item.quantity)}`;
        encoder.text(priceLine.padEnd(width - totalLine.length) + totalLine).newline();
        if (item.discountPercentage > 0) {
            const discountLine = `  Diskon (${item.discountPercentage}%)`;
            const discountAmount = (item.originalPrice - item.price) * item.quantity;
            const discountTotal = `-${formatCurrency(discountAmount)}`;
            encoder.text(discountLine.padEnd(width - discountTotal.length) + discountTotal).newline();
        }
    });
    encoder.text(divider).newline();

    const subtotalLabel = 'Subtotal';
    const subtotalValue = formatCurrency(t.subtotal);
    encoder.text(subtotalLabel.padEnd(width - subtotalValue.length) + subtotalValue).newline();

    (t.fees || []).forEach(fee => {
        const feeLabel = `${fee.name} ${fee.type === 'percentage' ? `(${fee.value}%)` : ''}`;
        const feeValue = formatCurrency(fee.amount);
        encoder.text(feeLabel.padEnd(width - feeValue.length) + feeValue).newline();
    });

    encoder.bold(true);
    const totalLabel = 'TOTAL';
    const totalValue = formatCurrency(t.total);
    encoder.text(totalLabel.padEnd(width - totalValue.length) + totalValue).newline();
    encoder.bold(false).text(divider.replace(/-/g, '=')).newline();

    const cashLabel = 'Tunai';
    const cashValue = formatCurrency(t.cashPaid);
    encoder.text(cashLabel.padEnd(width - cashValue.length) + cashValue).newline();

    const changeLabel = 'Kembalian';
    const changeValue = formatCurrency(t.change);
    encoder.text(changeLabel.padEnd(width - changeValue.length) + changeValue).newline();
    encoder.text(divider).newline();

    const feedbackPhone = await getSettingFromDB('storeFeedbackPhone', '');
    const storeFooterText = await getSettingFromDB('storeFooterText', 'Terima Kasih!');

    encoder.align('center');
    if (feedbackPhone) encoder.text(`Kritik & Saran: ${feedbackPhone}`).newline();
    encoder.text(storeFooterText).newline().feed(3).cut();

    const data = encoder.encode();
    showToast('Mengirim ke printer...');
    const success = await sendDataToBluetoothPrinter(data);
    if (success) {
        showToast('Berhasil dikirim ke printer.');
    }
}

window.testPrint = async function() {
    if (!isPrinterReady) {
        showToast('Fitur cetak tidak tersedia (library gagal dimuat).');
        console.error("testPrint called but printer library is not ready.");
        return;
    }
    const encoder = new EscPosEncoder();
    const paperSize = document.getElementById('printerPaperSize').value;
    const width = paperSize === '58mm' ? 32 : 42;

    const encodedData = encoder.initialize().align('center').width(2).height(2).text('Tes Cetak').width(1).height(1).newline().text('-'.repeat(width)).newline().align('left').text('Ini adalah tes cetak dari aplikasi POS.').newline().text('Jika Anda bisa membaca ini, printer').newline().text('Anda berhasil terhubung!').newline().text('-'.repeat(width)).newline().align('center').text('Terima Kasih!').newline().feed(3).cut().encode();

    showToast('Mengirim tes cetak...');
    const success = await sendDataToBluetoothPrinter(encodedData);
    if (success) {
        showToast('Tes cetak berhasil dikirim.');
    }
}

// --- QR CODE GENERATOR ---
function setupQRCodeGenerator() {
    const textInput = document.getElementById('barcodeInput');
    const generateBtn = document.getElementById('generateQrBtn');
    const downloadBtn = document.getElementById('downloadQrBtn');
    const qrcodeContainer = document.getElementById('qrcodeContainer');
    const tempCanvas = document.getElementById('tempCanvas');
    const outputContainer = document.getElementById('barcodeOutput');
    let qrcode = null;

    if (!generateBtn) return; // Guard clause if element not found

    generateBtn.addEventListener('click', () => {
        // Hide output and download button initially
        outputContainer.classList.add('hidden');
        downloadBtn.classList.add('hidden');
        const text = textInput.value.trim();

        if (text) {
            try {
                // Check if QRCode library is loaded
                if (typeof QRCode === 'undefined') {
                    showToast('Pustaka QR Code gagal dimuat. Coba muat ulang halaman.');
                    return;
                }
                
                // Clear previous QR code
                qrcodeContainer.innerHTML = '';
                outputContainer.classList.remove('hidden');
                
                // Create new QR code
                qrcode = new QRCode(qrcodeContainer, {
                    text: text,
                    width: 256,
                    height: 256,
                    colorDark : "#000000",
                    colorLight : "#ffffff",
                    correctLevel : QRCode.CorrectLevel.H
                });
                
                // Show download button
                downloadBtn.classList.remove('hidden');
                
                // Set download filename
                const safeFilename = text.replace(/[^a-z0-9]/gi, '_').substring(0, 50);
                const filename = `qrcode-${safeFilename}.png`;
                downloadBtn.setAttribute('download', filename);

                // Delay to ensure QR code canvas is rendered before combining
                setTimeout(() => {
                    const qrCodeCanvas = qrcodeContainer.querySelector('canvas');
                    if (qrCodeCanvas) {
                        const qrSize = qrCodeCanvas.width;
                        const padding = 20;
                        const textMargin = 10;
                        const textFontSize = 18;
                        
                        const ctx = tempCanvas.getContext('2d');
                        ctx.font = `${textFontSize}px sans-serif`;
                        const textMetrics = ctx.measureText(text);
                        const textWidth = textMetrics.width;
                        
                        // Calculate canvas dimensions
                        const combinedWidth = Math.max(qrSize, textWidth) + padding * 2;
                        const combinedHeight = qrSize + padding + textMargin + textFontSize;
                        
                        tempCanvas.width = combinedWidth;
                        tempCanvas.height = combinedHeight;
                        
                        // Draw white background
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, combinedWidth, combinedHeight);

                        // Draw QR Code centered
                        const qrX = (combinedWidth - qrSize) / 2;
                        ctx.drawImage(qrCodeCanvas, qrX, padding);
                        
                        // Draw text below QR Code
                        ctx.fillStyle = '#000000';
                        ctx.font = `${textFontSize}px sans-serif`;
                        ctx.textAlign = 'center';
                        ctx.fillText(text, combinedWidth / 2, qrSize + padding + textMargin + textFontSize - 4);
                        
                        // Set download link to the combined canvas image
                        downloadBtn.href = tempCanvas.toDataURL('image/png');
                    } else {
                        console.error("Could not find canvas generated by QRCode.js");
                        showToast("Gagal mempersiapkan file unduhan.");
                    }
                }, 500);

            } catch (error) {
                console.error("QR Code generation error:", error);
                showToast("Gagal membuat QR Code. Coba teks lain.");
                outputContainer.classList.add('hidden');
                downloadBtn.classList.add('hidden');
            }
        } else {
            showToast("Mohon masukkan teks terlebih dahulu.");
        }
    });
}


// --- INITIALIZATION ---
function setupCommonListeners() {
    document.getElementById('cancelButton')?.addEventListener('click', closeConfirmationModal);
    document.getElementById('confirmButton')?.addEventListener('click', () => {
        if (confirmCallback) {
            confirmCallback();
        }
        closeConfirmationModal();
    });

    document.getElementById('cashPaidInput')?.addEventListener('input', calculateChange);
    
    const today = new Date().toISOString().split('T')[0];
    (document.getElementById('dateFrom')).value = today;
    (document.getElementById('dateTo')).value = today;

    setupQRCodeGenerator();
}

async function startApp() {
    try {
        // --- 1. Initialize synchronously loaded libraries ---
        if (window.EscPosEncoder && typeof window.EscPosEncoder.default === 'function') {
            EscPosEncoder = window.EscPosEncoder.default;
            isPrinterReady = true;
            console.log("Printer library (escpos-encoder) loaded synchronously.");
        } else {
            isPrinterReady = false;
            console.error("Embedded escpos-encoder.js library is missing or failed to load.");
            showToast('Gagal memuat library printer. Fitur cetak tidak akan berfungsi.', 5000);
        }

        // --- 2. Wait for deferred libraries to load ---
        await new Promise((resolve) => {
            const maxWaitTime = 10000; // 10 seconds for scanner library
            const checkInterval = 100;
            let elapsedTime = 0;

            const intervalId = setInterval(() => {
                // Check for scanner library
                if (!isScannerReady && typeof window.Html5Qrcode === 'function') {
                    try {
                        html5QrCode = new Html5Qrcode("qr-reader");
                        isScannerReady = true;
                        console.log("Scanner library (html5-qrcode) loaded.");
                    } catch (e) {
                        console.error("Error initializing Html5Qrcode:", e);
                        // isScannerReady remains false
                    }
                }
                
                // If scanner is loaded, we're done
                if (isScannerReady) {
                    clearInterval(intervalId);
                    resolve();
                    return;
                }

                // Check for timeout
                elapsedTime += checkInterval;
                if (elapsedTime >= maxWaitTime) {
                    clearInterval(intervalId);
                    if (!isScannerReady) {
                        console.error('html5-qrcode.js library failed to load within the timeout.');
                        showToast('Gagal memuat library pemindai barcode. Fitur scan tidak akan berfungsi.', 5000);
                    }
                    resolve(); // Resolve anyway to start the rest of the app
                }
            }, checkInterval);
        });

        // --- 3. Initialize the database and app ---
        await initDB();

        // --- 4. Run application setup functions ---
        updateFeatureAvailability();
        setupCommonListeners();
        loadDashboard();
        loadProducts();
        loadStoreSettings();
        await checkForRestore();
        setupSearch();
        runDailyBackupCheck();
        updateBluetoothStatusUI();

        window.addEventListener('online', checkOnlineStatus);
        window.addEventListener('offline', checkOnlineStatus);
        await checkOnlineStatus();
        await window.syncWithServer();
        setInterval(() => window.syncWithServer(), 5 * 60 * 1000);

    } catch (error) {
        console.error("A critical error occurred during app initialization:", error);
        const loadingOverlay = document.getElementById('loadingOverlay');
        if (loadingOverlay) {
            loadingOverlay.innerHTML = `
                <div class="fixed inset-0 bg-gray-100 flex flex-col items-center justify-center p-8 text-center">
                    <i class="fas fa-exclamation-circle text-5xl text-red-500 mb-4"></i>
                    <h1 class="text-2xl font-bold text-gray-800 mb-2">Gagal Memuat Aplikasi</h1>
                    <p class="text-gray-600">
                        Terjadi kesalahan fatal saat memulai aplikasi. Ini mungkin disebabkan oleh masalah database atau browser.
                        Coba muat ulang halaman. Jika masalah berlanjut, hubungi dukungan.
                    </p>
                    <p class="text-xs text-gray-400 mt-4">Detail: ${error.message || error}</p>
                </div>
            `;
        }
    } finally {
        const loadingOverlay = document.getElementById('loadingOverlay');
        const isErrorState = loadingOverlay && loadingOverlay.querySelector('.fa-exclamation-circle');

        if (loadingOverlay && !isErrorState) {
            loadingOverlay.classList.add('opacity-0');
            setTimeout(() => {
                loadingOverlay.style.display = 'none';
            }, 300);
        }
    }
}

// Start the app after the DOM is ready
document.addEventListener('DOMContentLoaded', startApp);
