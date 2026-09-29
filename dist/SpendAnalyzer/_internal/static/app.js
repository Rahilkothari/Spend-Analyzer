document.addEventListener('DOMContentLoaded', () => {
    const uploadForm = document.getElementById('upload-form');
    const uploadView = document.getElementById('upload-view');
    const processingView = document.getElementById('processing-view');
    const dashboardView = document.getElementById('dashboard-view');
    const exportBtn = document.getElementById('export-btn');
    
    let dashboardData = null;
    let currentTxPage = 1;
    const TX_PER_PAGE = 50;

    // File input label updating
    document.querySelectorAll('.file-input').forEach(input => {
        input.addEventListener('change', function() {
            if (this.files && this.files[0]) {
                let msg = this.parentElement.querySelector('.file-msg');
                msg.textContent = this.files[0].name;
                msg.style.color = 'var(--accent)';
            }
        });
    });

    // Tab Switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
            
            e.target.classList.add('active');
            const targetId = e.target.getAttribute('data-target');
            document.getElementById(targetId).style.display = 'block';
        });
    });

    // Switch to tab programmatically
    function switchTab(targetId) {
        document.querySelector(`.tab-btn[data-target="${targetId}"]`).click();
    }

    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        uploadView.style.display = 'none';
        processingView.style.display = 'block';

        const formData = new FormData();
        formData.append('bank_statement', document.getElementById('bank-statement').files[0]);
        

        const note = document.getElementById('context-note').value;
        if (note) formData.append('context_note', note);

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();
            if (result.status === 'success') {
                dashboardData = result.data;
                renderDashboard(dashboardData);
            } else {
                alert('Error: ' + result.message);
                resetView();
            }
        } catch (error) {
            alert('Error processing file. See console.');
            console.error(error);
            resetView();
        }
    });

    function resetView() {
        uploadView.style.display = 'block';
        processingView.style.display = 'none';
    }

    function formatCurrency(amount) {
        return '₹' + parseFloat(amount).toLocaleString('en-IN', {minimumFractionDigits: 0, maximumFractionDigits: 0});
    }

    // Chart instances
    let monthlySpendChartInstance = null;
    let monthlyCategoryChartInstance = null;
    let needsWantsChartInstance = null;

    function renderDashboard(data) {
        processingView.style.display = 'none';
        dashboardView.style.display = 'block';
        exportBtn.style.display = 'block';

        renderOverview(data);
        renderMonthlyTrends(data);
        renderCategoryExplorer(data);
        setupTransactions(data);
        renderTopFrequent(data);
        renderNeedsWants(data);
    }

    function renderOverview(data) {
        const o = data.overview;
        document.getElementById('stat-balance').textContent = formatCurrency(o.closing_balance);
        
        // Reconciliation check
        if (Math.abs(o.reconciliation_diff) > 0.01) {
            document.getElementById('reconciliation-alert').style.display = 'block';
            document.getElementById('reconciliation-msg').textContent = `Warning: The net computed from transactions differs from the statement balance change by ₹${o.reconciliation_diff}. Some transactions may have been missed or duplicated.`;
        } else {
            document.getElementById('reconciliation-alert').style.display = 'none';
        }

        // Top 5 Categories & Insights
        const catList = document.getElementById('top-categories-list');
        catList.innerHTML = '';
        data.categories.slice(0, 5).forEach(cat => {
            const li = document.createElement('li');
            li.innerHTML = `
                <div>
                    <span style="display:block; font-weight:600;">${cat.name}</span>
                    <span style="font-size:0.8rem; color:var(--text-muted);">${cat.insight}</span>
                </div>
                <span style="font-weight:700;">${formatCurrency(cat.amount)}</span>
            `;
            catList.appendChild(li);
        });

        // Verdicts
        const verdictsContainer = document.getElementById('month-verdicts-container');
        verdictsContainer.innerHTML = '';
        const verdicts = data.month_verdicts || {};
        Object.keys(verdicts).sort((a, b) => new Date(a) - new Date(b)).forEach(month => {
            const v = verdicts[month];
            const div = document.createElement('div');
            div.className = 'verdict-card';
            const colorClass = v.net >= 0 ? 'positive' : 'negative';
            div.innerHTML = `
                <div class="verdict-month">${month}</div>
                <div class="verdict-net" style="color: var(--${colorClass});">${formatCurrency(v.net)}</div>
                <div class="verdict-reason">${v.reason}</div>
            `;
            verdictsContainer.appendChild(div);
        });
    }

    function renderMonthlyTrends(data) {
        const trends = data.monthly_trends;
        const months = Object.keys(trends.spend).sort((a, b) => new Date(a) - new Date(b)); 
        // Best to trust backend order or parse it. Let's trust backend order for now, it's usually chronological if we extract from statement top to bottom.
        
        // 1. Spend & Net line
        const spendCtx = document.getElementById('monthlySpendChart').getContext('2d');
        if (monthlySpendChartInstance) monthlySpendChartInstance.destroy();
        
        monthlySpendChartInstance = new Chart(spendCtx, {
            type: 'bar',
            data: {
                labels: months,
                datasets: [
                    {
                        label: 'Net Savings',
                        type: 'line',
                        data: months.map(m => trends.net[m]),
                        borderColor: '#8b5cf6',
                        borderWidth: 2,
                        tension: 0.3,
                        pointBackgroundColor: '#8b5cf6',
                        yAxisID: 'y'
                    },
                    {
                        label: 'Total Income',
                        data: months.map(m => trends.income ? trends.income[m] : 0),
                        backgroundColor: 'rgba(16, 185, 129, 0.7)',
                        borderRadius: 4,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Total Spend',
                        data: months.map(m => trends.spend[m]),
                        backgroundColor: 'rgba(59, 130, 246, 0.7)',
                        borderRadius: 4,
                        yAxisID: 'y'
                    }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                onClick: (e, elements) => {
                    if (elements.length > 0) {
                        const index = elements[0].index;
                        const month = months[index];
                        document.getElementById('filter-month').value = month;
                        filterTransactions();
                        switchTab('tab-transactions');
                    }
                },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#94a3b8' } },
                    y: { grid: { color: 'rgba(255,255,255,0.1)' }, ticks: { color: '#94a3b8' } }
                },
                plugins: { legend: { labels: { color: '#f1f5f9' } } }
            }
        });

        // 2. Category Stacked Bar (Top 6 + Other)
        // Find top 6 overall categories
        const top6 = data.categories.slice(0, 6).map(c => c.name);
        
        const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#64748b']; // last is Other
        
        const datasets = [];
        top6.forEach((catName, index) => {
            datasets.push({
                label: catName,
                data: months.map(m => {
                    const found = trends.categories[m].find(c => c.name === catName);
                    return found ? found.amount : 0;
                }),
                backgroundColor: colors[index],
                borderWidth: 0
            });
        });
        
        // Compute "Other"
        datasets.push({
            label: 'Other',
            data: months.map(m => {
                let sum = 0;
                trends.categories[m].forEach(c => {
                    if (!top6.includes(c.name)) sum += c.amount;
                });
                return sum;
            }),
            backgroundColor: colors[6],
            borderWidth: 0
        });

        const catCtx = document.getElementById('monthlyCategoryChart').getContext('2d');
        if (monthlyCategoryChartInstance) monthlyCategoryChartInstance.destroy();

        monthlyCategoryChartInstance = new Chart(catCtx, {
            type: 'bar',
            data: { labels: months, datasets: datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    x: { stacked: true, grid: { display: false }, ticks: { color: '#94a3b8' } },
                    y: { stacked: true, grid: { color: 'rgba(255,255,255,0.1)' }, ticks: { color: '#94a3b8' } }
                },
                plugins: {
                    legend: { position: 'right', labels: { color: '#f1f5f9' } }
                },
                onClick: (e, elements) => {
                    if (elements.length > 0) {
                        const element = elements[0];
                        const month = months[element.index];
                        const datasetIndex = element.datasetIndex;
                        const categoryName = datasets[datasetIndex].label;

                        document.getElementById('filter-month').value = month;
                        
                        // Only filter by category if it's not the "Other" bucket
                        if (categoryName !== 'Other') {
                            document.getElementById('filter-category').value = categoryName;
                        } else {
                            document.getElementById('filter-category').value = 'All';
                        }
                        
                        filterTransactions();
                        switchTab('tab-transactions');
                    }
                }
            }
        });
    }

    function renderCategoryExplorer(data, selectedMonth = 'All') {
        const tbody = document.querySelector('#category-explorer-table tbody');
        tbody.innerHTML = '';
        
        let catsToRender = [];
        if (selectedMonth === 'All') {
            catsToRender = data.categories;
        } else {
            // Compute monthly categories with count and average
            const monthTxs = data.transactions.filter(t => t.month_year === selectedMonth && t.type === 'Debit');
            const totalOut = monthTxs.reduce((sum, t) => sum + t.amount, 0);
            
            const catMap = {};
            monthTxs.forEach(t => {
                if (!catMap[t.category]) catMap[t.category] = { name: t.category, amount: 0, count: 0 };
                catMap[t.category].amount += t.amount;
                catMap[t.category].count += 1;
            });
            
            catsToRender = Object.values(catMap).map(c => {
                c.percent = totalOut ? ((c.amount / totalOut) * 100).toFixed(1) : 0;
                return c;
            });
            catsToRender.sort((a, b) => b.amount - a.amount);
        }
        
        catsToRender.forEach(cat => {
            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.innerHTML = `
                <td>${cat.name}</td>
                <td style="font-weight:600;">${formatCurrency(cat.amount)}</td>
                <td>${cat.count}</td>
                <td>${formatCurrency(cat.amount / cat.count)}</td>
                <td>${cat.percent}%</td>
            `;
            tr.addEventListener('click', () => {
                document.getElementById('filter-month').value = selectedMonth;
                document.getElementById('filter-category').value = cat.name;
                filterTransactions();
                switchTab('tab-transactions');
            });
            tbody.appendChild(tr);
        });
    }

    let filteredTxs = [];
    
    function setupTransactions(data) {
        filteredTxs = [...data.transactions];
        
        const monthSelect = document.getElementById('filter-month');
        const catSelect = document.getElementById('filter-category');
        const catExplorerMonthSelect = document.getElementById('filter-cat-explorer-month');
        const debitsMonthSelect = document.getElementById('filter-debits-month');
        const debitsCatSelect = document.getElementById('filter-debits-category');
        
        // Populate filters
        const months = [...new Set(data.transactions.filter(t => t.month_year && t.month_year !== 'Unknown').map(t => t.month_year))];
        months.sort((a, b) => new Date(a) - new Date(b));
        months.forEach(m => {
            const opt1 = document.createElement('option'); opt1.value = m; opt1.textContent = m;
            monthSelect.appendChild(opt1);
            const opt2 = document.createElement('option'); opt2.value = m; opt2.textContent = m;
            catExplorerMonthSelect.appendChild(opt2);
        });
        
        catExplorerMonthSelect.addEventListener('change', (e) => {
            renderCategoryExplorer(data, e.target.value);
        });

        data.categories.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.name; opt.textContent = c.name;
            catSelect.appendChild(opt);
        });
        
        // Listeners for All Transactions
        const typeSelect = document.getElementById('filter-type');
        if (typeSelect) typeSelect.addEventListener('change', filterTransactions);
        monthSelect.addEventListener('change', filterTransactions);
        catSelect.addEventListener('change', filterTransactions);
        document.getElementById('tx-search').addEventListener('keyup', filterTransactions);
        
        document.getElementById('page-prev').addEventListener('click', () => {
            if (currentTxPage > 1) { currentTxPage--; renderTxTable(); }
        });
        document.getElementById('page-next').addEventListener('click', () => {
            if (currentTxPage * TX_PER_PAGE < filteredTxs.length) { currentTxPage++; renderTxTable(); }
        });
        
        // Sorting for All Transactions
        document.querySelectorAll('#tx-table th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const sortKey = th.getAttribute('data-sort');
                filteredTxs.sort((a, b) => {
                    let valA = a[sortKey];
                    let valB = b[sortKey];
                    if (sortKey === 'amount') { valA = parseFloat(valA); valB = parseFloat(valB); }
                    if (valA < valB) return -1;
                    if (valA > valB) return 1;
                    return 0;
                });
                // Toggle reverse
                if (th.classList.contains('asc')) {
                    filteredTxs.reverse();
                    th.classList.remove('asc');
                } else {
                    th.classList.add('asc');
                }
                currentTxPage = 1;
                renderTxTable();
            });
        });

        filterTransactions();
    }

    window.filterTransactions = function() {
        const t = document.getElementById('filter-type') ? document.getElementById('filter-type').value : 'All';
        const m = document.getElementById('filter-month').value;
        const c = document.getElementById('filter-category').value;
        const s = document.getElementById('tx-search').value.toLowerCase();
        
        let totalDebits = 0;
        let totalCredits = 0;

        filteredTxs = dashboardData.transactions.filter(tx => {
            const matchT = t === 'All' || tx.type === t;
            const matchM = m === 'All' || tx.month_year === m;
            const matchC = c === 'All' || tx.category === c;
            const matchS = s === '' || tx.merchant.toLowerCase().includes(s) || (tx.note && tx.note.toLowerCase().includes(s));
            
            if (matchT && matchM && matchC && matchS) {
                if (tx.category !== 'Ignored/Refund' && tx.category !== 'Family/Self Transfer') {
                    if (tx.type === 'Debit') {
                        totalDebits += tx.amount;
                    } else {
                        // Credit
                        if (tx.category === 'Income') {
                            totalCredits += tx.amount;
                        } else {
                            // Reimbursement
                            totalDebits -= tx.amount;
                        }
                    }
                }
                return true;
            }
            return false;
        });
        
        const txSummary = document.getElementById('tx-summary');
        if (txSummary) {
            const net = totalCredits - totalDebits;
            const netColor = net >= 0 ? 'var(--positive)' : 'var(--negative)';
            txSummary.innerHTML = `
                <span style="color: var(--negative);">Total Debits: ${formatCurrency(totalDebits)}</span>
                <span style="color: var(--positive);">Total Credits: ${formatCurrency(totalCredits)}</span>
                <span style="color: ${netColor};">Net: ${formatCurrency(net)}</span>
            `;
        }
        
        currentTxPage = 1;
        renderTxTable();
    }

    // Calculator state
    const selectedCalcTxs = new Map(); // tx_id -> {amount, type, merchant}

    function updateCalcTray() {
        const tray = document.getElementById('calc-tray');
        const countEl = document.getElementById('calc-count');
        const totalEl = document.getElementById('calc-total');
        const breakdownEl = document.getElementById('calc-breakdown');
        if (selectedCalcTxs.size === 0) {
            tray.style.display = 'none';
            return;
        }
        tray.style.display = 'flex';
        let debits = 0, credits = 0;
        selectedCalcTxs.forEach(tx => {
            if (tx.type === 'Debit') debits += tx.amount;
            else credits += tx.amount;
        });
        const net = debits - credits;
        countEl.textContent = selectedCalcTxs.size + ' selected';
        totalEl.textContent = formatCurrency(net);
        totalEl.style.color = net <= 0 ? 'var(--positive)' : 'var(--accent)';
        breakdownEl.textContent = selectedCalcTxs.size > 1
            ? `(${formatCurrency(debits)} debits − ${formatCurrency(credits)} credits)`
            : '';
    }

    document.getElementById('calc-clear').addEventListener('click', () => {
        selectedCalcTxs.clear();
        document.querySelectorAll('.calc-btn.selected').forEach(btn => {
            btn.classList.remove('selected');
            btn.textContent = '+';
            btn.style.background = 'rgba(255,255,255,0.08)';
            btn.style.color = 'var(--accent)';
            btn.closest('tr').style.background = '';
        });
        updateCalcTray();
    });

    function renderTxTable() {
        const tbody = document.querySelector('#tx-table tbody');
        tbody.innerHTML = '';
        
        const start = (currentTxPage - 1) * TX_PER_PAGE;
        const end = start + TX_PER_PAGE;
        const pageTxs = filteredTxs.slice(start, end);
        
        pageTxs.forEach(tx => {
            const tr = document.createElement('tr');
            const typeClass = tx.type === 'Debit' ? 'debit' : 'credit';
            const noteHtml = tx.note ? `<em>${tx.note}</em>` : '-';
            
            const dateHtml = `<span style="cursor:pointer; color:var(--accent);" onclick="openMonthModal('${tx.tx_id}', '${tx.date}', '${tx.month_year}')" title="Click to edit month">${tx.date} ✎</span>`;
            const catHtml = `<span style="background:rgba(255,255,255,0.1); padding:4px 8px; border-radius:4px; font-size:0.8rem; cursor:pointer; color:var(--accent);" onclick="openMiscModal('${tx.merchant.replace(/'/g, "\\'")}', '${tx.tx_id}')" title="Click to edit category">${tx.category} ✎</span>`;
            
            const isSelected = selectedCalcTxs.has(tx.tx_id);
            const calcBtnStyle = isSelected
                ? 'background:var(--accent); color:#fff;'
                : 'background:rgba(255,255,255,0.08); color:var(--accent);';
            if (isSelected) tr.style.background = 'rgba(139,92,246,0.1)';

            tr.innerHTML = `
                <td><button class="calc-btn${isSelected ? ' selected' : ''}" data-txid="${tx.tx_id}" style="border:none; border-radius:50%; width:26px; height:26px; cursor:pointer; font-size:1rem; font-weight:700; ${calcBtnStyle}">${isSelected ? '−' : '+'}</button></td>
                <td>${dateHtml}</td>
                <td>${tx.merchant}</td>
                <td>${noteHtml}</td>
                <td>${catHtml}</td>
                <td class="${typeClass}" style="font-weight:600;">${formatCurrency(tx.amount)}</td>
            `;

            // Wire up the + button
            tr.querySelector('.calc-btn').addEventListener('click', function() {
                const txId = this.dataset.txid;
                if (selectedCalcTxs.has(txId)) {
                    selectedCalcTxs.delete(txId);
                    this.classList.remove('selected');
                    this.textContent = '+';
                    this.style.background = 'rgba(255,255,255,0.08)';
                    this.style.color = 'var(--accent)';
                    tr.style.background = '';
                } else {
                    selectedCalcTxs.set(txId, { amount: tx.amount, type: tx.type, merchant: tx.merchant });
                    this.classList.add('selected');
                    this.textContent = '−';
                    this.style.background = 'var(--accent)';
                    this.style.color = '#fff';
                    tr.style.background = 'rgba(139,92,246,0.1)';
                }
                updateCalcTray();
            });

            tbody.appendChild(tr);
        });
        
        const maxPages = Math.ceil(filteredTxs.length / TX_PER_PAGE) || 1;
        document.getElementById('page-info').textContent = `Page ${currentTxPage} of ${maxPages} (${filteredTxs.length} items)`;
    }

    function renderTopFrequent(data) {
        // Top 15
        const t15 = document.querySelector('#top-15-table tbody');
        t15.innerHTML = '';
        data.top_15_overall.forEach(tx => {
            t15.innerHTML += `<tr><td>${tx.date}</td><td>${tx.merchant}</td><td>${tx.category}</td><td class="debit">${formatCurrency(tx.amount)}</td></tr>`;
        });
        
        // Frequent
        const freq = document.querySelector('#frequent-table tbody');
        freq.innerHTML = '';
        data.top_frequent.forEach(f => {
            freq.innerHTML += `<tr><td>${f.merchant}</td><td>${f.count}</td><td>${formatCurrency(f.amount)}</td></tr>`;
        });
    }

    function renderNeedsWants(data) {
        const trends = data.monthly_trends;
        const months = Object.keys(trends.spend).sort((a, b) => new Date(a) - new Date(b));
        
        const nwKeys = ['Need', 'Want', 'Save/Invest', 'Neutral'];
        const colors = ['#3b82f6', '#f59e0b', '#10b981', '#64748b'];
        
        const datasets = nwKeys.map((k, i) => {
            return {
                label: k,
                data: months.map(m => trends.needs_wants[m][k] || 0),
                backgroundColor: colors[i],
                borderWidth: 0
            };
        });

        const ctx = document.getElementById('needsWantsChart').getContext('2d');
        if (needsWantsChartInstance) needsWantsChartInstance.destroy();
        
        needsWantsChartInstance = new Chart(ctx, {
            type: 'bar',
            data: { labels: months, datasets: datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    x: { stacked: true, grid: { display: false }, ticks: { color: '#94a3b8' } },
                    y: { stacked: true, grid: { color: 'rgba(255,255,255,0.1)' }, ticks: { color: '#94a3b8' } }
                },
                plugins: { legend: { labels: { color: '#f1f5f9' } } }
            }
        });
        
        // Compute overall Wants percentage for callout
        let totalWants = 0, totalSpend = 0;
        months.forEach(m => {
            totalWants += trends.needs_wants[m]['Want'] || 0;
            totalSpend += trends.spend[m] || 0;
        });
        
        const wantsPct = totalSpend > 0 ? (totalWants / totalSpend) * 100 : 0;
        const twentyPctCut = totalWants * 0.2 / (months.length || 1); // monthly average cut
        
        document.getElementById('needs-wants-callout').innerHTML = `
            <strong>Insight:</strong> Wants make up ${wantsPct.toFixed(1)}% of your total spend. 
            A 20% cut in discretionary spending would save you ~<strong>${formatCurrency(twentyPctCut)}/month</strong>.
        `;
    }

    // Modal Logic
    const modal = document.getElementById('misc-modal');
    let currentEditCatTxId = null;
    window.openMiscModal = function(merchantName, txId) {
        document.getElementById('misc-merchant-name').textContent = merchantName;
        currentEditCatTxId = txId || null;
        modal.style.display = 'block';
    }
    document.getElementById('close-modal').onclick = () => modal.style.display = 'none';
    window.onclick = (e) => { if (e.target == modal) modal.style.display = 'none'; }
    
    document.getElementById('misc-save-btn').onclick = async () => {
        const newCat = document.getElementById('misc-category-select').value;
        const merchant = document.getElementById('misc-merchant-name').textContent;
        const miscSaveBtn = document.getElementById('misc-save-btn');
        const modal = document.getElementById('misc-modal');
        
        // Update local state first
        dashboardData.transactions.forEach(t => {
            if (t.merchant === merchant) {
                t.category = newCat;
            }
        });
        
        modal.style.display = 'none';
        
        try {
            // Save merchant-level mapping (for future uploads)
            await fetch('/api/mapping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ merchant: merchant, category: newCat })
            });
            
            // Save per-transaction override (for this specific transaction permanently)
            if (currentEditCatTxId) {
                await fetch('/api/tx-override', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tx_id: currentEditCatTxId, field: 'category', value: newCat })
                });
            }
            
            miscSaveBtn.textContent = 'Recalculating...';
            const response = await fetch('/api/recalculate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transactions: dashboardData.transactions })
            });
            const resData = await response.json();
            if (resData.status === 'success') {
                dashboardData = resData.data;
                populateFilters();
                filterTransactions();
                renderDashboard(dashboardData);
            }
        } catch(e) {
            console.error(e);
        } finally {
            miscSaveBtn.textContent = 'Save Category';
        }
    };
    
    // Month Modal Logic
    const monthModal = document.getElementById('month-modal');
    const closeMonthModal = document.getElementById('close-month-modal');
    const monthSaveBtn = document.getElementById('month-save-btn');
    const monthSelect = document.getElementById('month-select');
    let currentEditTxId = null;

    window.openMonthModal = function(tx_id, dateStr, currentMonth) {
        currentEditTxId = tx_id;
        document.getElementById('month-tx-info').textContent = 'Date: ' + dateStr;
        
        let exists = false;
        for (let i = 0; i < monthSelect.options.length; i++) {
            if (monthSelect.options[i].value === currentMonth) exists = true;
        }
        if (!exists && currentMonth) {
            const opt = document.createElement('option');
            opt.value = currentMonth;
            opt.textContent = currentMonth;
            monthSelect.appendChild(opt);
        }
        
        monthSelect.value = currentMonth || '';
        monthModal.style.display = 'block';
    };

    if (closeMonthModal) closeMonthModal.onclick = () => { monthModal.style.display = 'none'; };
    
    if (monthSaveBtn) monthSaveBtn.onclick = async () => {
        const newMonth = monthSelect.value;
        monthModal.style.display = 'none';
        
        if (!currentEditTxId) return;
        
        // Update in memory
        const tx = dashboardData.transactions.find(t => t.tx_id === currentEditTxId);
        if (tx) {
            tx.month_year = newMonth;
        }
        
        // Recalculate
        try {
            monthSaveBtn.textContent = 'Saving...';
            // Persist month override so it survives re-uploads
            await fetch('/api/tx-override', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tx_id: currentEditTxId, field: 'month_year', value: newMonth })
            });
            const response = await fetch('/api/recalculate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transactions: dashboardData.transactions })
            });
            const resData = await response.json();
            if (resData.status === 'success') {
                dashboardData = resData.data;
                populateFilters();
                filterTransactions();
                renderDashboard(dashboardData);
            } else {
                alert('Recalculation failed');
            }
        } catch(e) {
            alert('Failed to reach backend');
        } finally {
            monthSaveBtn.textContent = 'Save Month';
        }
    };


    // Export Logic
    exportBtn.addEventListener('click', async () => {
        if (!dashboardData) return;
        exportBtn.textContent = 'Generating...';
        
        try {
            const response = await fetch('/api/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(dashboardData)
            });
            
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = 'budget_analysis.xlsx';
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
        } catch (e) {
            alert('Export failed.');
            console.error(e);
        } finally {
            exportBtn.textContent = 'Export Excel Report';
        }
    });
});
