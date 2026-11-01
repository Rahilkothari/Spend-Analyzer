document.addEventListener('DOMContentLoaded', () => {
    const uploadForm = document.getElementById('upload-form');
    const uploadView = document.getElementById('upload-view');
    const processingView = document.getElementById('processing-view');
    const dashboardView = document.getElementById('dashboard-view');
    const exportBtn = document.getElementById('export-btn');
    
    let dashboardData = null;
    let currentTxPage = 1;
    const TX_PER_PAGE = 50;
    
    // Load active session if it exists
    fetch('/api/load-session').then(res => res.json()).then(result => {
        if (result.status === 'success' && result.data) {
            dashboardData = result.data;
            uploadView.style.display = 'none';
            renderDashboard(dashboardData);
            
            // Restore active tab
            let savedTab = localStorage.getItem('activeTab');
            if (savedTab === 'tab-monthly' || savedTab === 'tab-needs') savedTab = 'tab-overview';
            if (savedTab) {
                const btn = document.querySelector(`.tab-btn[data-target="${savedTab}"]`);
                if (btn) btn.click();
            }
        }
    }).catch(e => console.log('No session found'));

    // Multi-file input display helper
    function setupFileInput(inputId, msgId, listId) {
        const input = document.getElementById(inputId);
        const msg = document.getElementById(msgId);
        const list = document.getElementById(listId);
        if (!input) return;

        input.addEventListener('change', function() {
            if (this.files && this.files.length > 0) {
                if (msg) {
                    if (this.files.length === 1) {
                        msg.textContent = this.files[0].name;
                    } else {
                        msg.textContent = `${this.files.length} statement files selected`;
                    }
                    msg.style.color = 'var(--accent)';
                }

                if (list) {
                    list.innerHTML = '';
                    list.style.display = 'block';
                    Array.from(this.files).forEach(f => {
                        const chip = document.createElement('span');
                        chip.className = 'file-chip';
                        const sizeKb = (f.size / 1024).toFixed(0);
                        chip.innerHTML = `📄 <strong>${f.name}</strong> <span style="opacity:0.7">(${sizeKb} KB)</span>`;
                        list.appendChild(chip);
                    });
                }
            }
        });
    }

    setupFileInput('bank-statement', 'upload-file-msg', 'upload-file-list');
    setupFileInput('append-bank-statement', 'append-file-msg', 'append-file-list');

    // Tab Switching
    function activateTab(targetId, skipHistory = false) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
        
        const btn = document.querySelector(`.tab-btn[data-target="${targetId}"]`);
        if (btn) btn.classList.add('active');
        const content = document.getElementById(targetId);
        if (content) content.style.display = 'block';
        
        localStorage.setItem('activeTab', targetId);
        
                if (targetId === 'tab-insights' && window.dashboardData) {
            setTimeout(() => {
                if (window.renderSpendInsights) window.renderSpendInsights(window.dashboardData);
            }, 60);
        }

        if (targetId === 'tab-monthly-breakdown' && window.dashboardData) {
            setTimeout(() => {
                if (window.renderMonthlyCategoryChart) window.renderMonthlyCategoryChart(window.dashboardData);
            }, 60);
        }

        if (!skipHistory) {
            history.pushState({ tab: targetId }, '', `#${targetId}`);
        }
    }

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetId = e.target.getAttribute('data-target');
            activateTab(targetId);
        });
    });

    window.addEventListener('popstate', (e) => {
        if (e.state && e.state.tab) {
            activateTab(e.state.tab, true);
        } else {
            // Fallback if no state
            const savedTab = localStorage.getItem('activeTab') || 'tab-overview';
            activateTab(savedTab, true);
        }
    });

    // Switch to tab programmatically
    function switchTab(targetId) {
        activateTab(targetId);
    }

    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const fileInput = document.getElementById('bank-statement');
        if (!fileInput.files || fileInput.files.length === 0) {
            alert('Please select at least one statement file.');
            return;
        }

        uploadView.style.display = 'none';
        processingView.style.display = 'block';

        const formData = new FormData();
        for (let i = 0; i < fileInput.files.length; i++) {
            formData.append('bank_statements', fileInput.files[i]);
        }
        formData.append('bank_statement', fileInput.files[0]);

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
                showToast(`Loaded ${result.total_count || ''} transactions successfully!`, 'success');
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

    function getSortedMonths(data) {
        if (data.overview && data.overview.months_list && data.overview.months_list.length > 0) {
            return [...data.overview.months_list];
        }
        const months = [...new Set(data.transactions.filter(t => t.month_year && t.month_year !== 'Unknown').map(t => t.month_year))];
        months.sort((a, b) => new Date(a) - new Date(b));
        return months;
    }

    function populateFilterDropdowns(data) {
        const months = getSortedMonths(data);

        // 1. Transactions filter month
        const monthSelect = document.getElementById('filter-month');
        if (monthSelect) {
            const currentVal = monthSelect.value || 'All';
            monthSelect.innerHTML = '<option value="All">All Months</option>';
            months.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                monthSelect.appendChild(opt);
            });
            if (months.includes(currentVal)) {
                monthSelect.value = currentVal;
            } else {
                monthSelect.value = 'All';
            }
        }

        // 2. Category Explorer filter month
        const catExplorerMonthSelect = document.getElementById('filter-cat-explorer-month');
        if (catExplorerMonthSelect) {
            const currentVal = catExplorerMonthSelect.value || 'All';
            catExplorerMonthSelect.innerHTML = '<option value="All">All Months</option>';
            months.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                catExplorerMonthSelect.appendChild(opt);
            });
            if (months.includes(currentVal)) {
                catExplorerMonthSelect.value = currentVal;
            } else {
                catExplorerMonthSelect.value = 'All';
            }
        }

        // 3. Transactions filter category
        const catSelect = document.getElementById('filter-category');
        if (catSelect && data.categories) {
            const currentVal = catSelect.value || 'All';
            catSelect.innerHTML = '<option value="All">All Categories</option>';
            data.categories.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.name;
                opt.textContent = c.name;
                catSelect.appendChild(opt);
            });
            const catNames = data.categories.map(c => c.name);
            if (catNames.includes(currentVal)) {
                catSelect.value = currentVal;
            } else {
                catSelect.value = 'All';
            }
        }

        // 4. Modal month select
        const modalMonthSelect = document.getElementById('month-select');
        if (modalMonthSelect) {
            months.forEach(m => {
                let exists = false;
                for (let i = 0; i < modalMonthSelect.options.length; i++) {
                    if (modalMonthSelect.options[i].value === m) exists = true;
                }
                if (!exists) {
                    const opt = document.createElement('option');
                    opt.value = m;
                    opt.textContent = m;
                    modalMonthSelect.appendChild(opt);
                }
            });
        }
    }

    function renderDashboard(data) {
        dashboardData = data;
        window.dashboardData = data;
        processingView.style.display = 'none';
        dashboardView.style.display = 'block';
        exportBtn.style.display = 'block';
        const clearBtn = document.getElementById('clear-session-btn');
        if (clearBtn) clearBtn.style.display = 'block';

        const addBtn = document.getElementById('add-statement-btn');
        if (addBtn) addBtn.style.display = 'inline-flex';

        // 1. Update filter dropdown options FIRST so all views have all months
        populateFilterDropdowns(data);

        // 2. Update header dataset badge
        const badge = document.getElementById('dataset-period-badge');
        if (badge && data.overview) {
            const o = data.overview;
            const monthsCount = o.months_count || (o.months_list ? o.months_list.length : 1);
            const periodStr = o.period_str ? ` (${o.period_str})` : '';
            const txCount = o.tx_count || (data.transactions ? data.transactions.length : 0);
            badge.style.display = 'inline-flex';
            badge.innerHTML = `<span>📅</span> ${monthsCount} Months${periodStr} • ${txCount} txns`;
        }

        const safeRender = (name, fn) => { try { fn(); } catch(e) { console.error('[renderDashboard] ' + name + ' failed:', e); } };

        safeRender('renderOverview', () => renderOverview(data));
        safeRender('renderMonthlyCategoryChart', () => renderMonthlyCategoryChart(data));
        safeRender('renderSpendInsights', () => renderSpendInsights(data));

        const catExpMonth = document.getElementById('filter-cat-explorer-month') ? document.getElementById('filter-cat-explorer-month').value : 'All';
        safeRender('renderCategoryExplorer', () => renderCategoryExplorer(data, catExpMonth));

        safeRender('setupTransactions', () => setupTransactions(data));
        safeRender('renderTopFrequent', () => renderTopFrequent(data));
        safeRender('renderSplits', () => renderSplits(data));

        // Restore active tab
        const savedTab = localStorage.getItem('activeTab');
        const validTabs = ['tab-overview','tab-monthly-breakdown','tab-insights','tab-category','tab-transactions','tab-splits','tab-top','tab-assistant'];
        const defaultTab = (savedTab && validTabs.includes(savedTab)) ? savedTab : 'tab-overview';
        activateTab(defaultTab, true);
    }

    function renderOverview(data) {
        const o = data.overview || {};
        
        const totalSpendEl = document.getElementById('stat-total-spend');
        if (totalSpendEl) totalSpendEl.textContent = formatCurrency(o.total_spend || o.total_out || 0);

        const avgSpendEl = document.getElementById('stat-avg-spend');
        if (avgSpendEl) avgSpendEl.textContent = formatCurrency(o.avg_monthly_spend || 0);

        const actualSpendEl = document.getElementById('stat-actual-spend');
        if (actualSpendEl) actualSpendEl.textContent = formatCurrency(o.actual_spent || 0);

        // Investment Note
        const invNote = document.getElementById('investment-note');
        if (invNote) {
            if (o.investments_total > 0) {
                invNote.style.display = 'block';
                const invMsg = document.getElementById('investment-note-msg');
                if (invMsg) {
                    invMsg.innerHTML = `
                        Your total outflow was <strong>${formatCurrency(o.total_spend || o.total_out || 0)}</strong>. <br>
                        However, <strong>${formatCurrency(o.investments_total)}</strong> of that was moved into <strong>Investments</strong>. <br>
                        Therefore, your actual total spent is <strong style="color:var(--text); font-size:1.1rem;">${formatCurrency(o.actual_spent || 0)}</strong>.
                    `;
                }
            } else {
                invNote.style.display = 'none';
            }
        }

        // Top 5 Categories & Insights
        const catList = document.getElementById('top-categories-list');
        if (catList && data.categories) {
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
        }

        // Verdicts (Spend only)
        const verdictsContainer = document.getElementById('month-verdicts-container');
        if (verdictsContainer) {
            verdictsContainer.innerHTML = '';
            const verdicts = data.month_verdicts || {};
            Object.keys(verdicts).sort((a, b) => new Date(a) - new Date(b)).forEach(month => {
                const v = verdicts[month];
                const div = document.createElement('div');
                div.className = 'verdict-card';
                const vsBadge = (v.vs_avg !== undefined) ? `
                    <span style="font-size: 0.78rem; font-weight: 600; padding: 0.2rem 0.5rem; border-radius: 4px; background: ${v.vs_avg > 0 ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)'}; color: ${v.vs_avg > 0 ? '#f87171' : '#34d399'};">
                        ${v.vs_avg > 0 ? '▲ +' + v.vs_avg + '% vs avg' : (v.vs_avg < 0 ? '▼ ' + v.vs_avg + '% vs avg' : '~ at avg')}
                    </span>
                ` : '';
                div.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                        <span class="verdict-month" style="font-weight: 700; font-size: 1.1rem; color: var(--accent);">${month}</span>
                        ${vsBadge}
                    </div>
                    <div style="margin-bottom: 0.5rem;">
                        <span style="font-size: 0.8rem; color: var(--text-muted);">Month Spend:</span>
                        <span style="color: var(--negative); font-weight: 700; font-size: 1.2rem; margin-left: 0.35rem;">${formatCurrency(v.spend || 0)}</span>
                    </div>
                    <div class="verdict-reason" style="font-size: 0.85rem; color: var(--text-muted); padding-top: 0.5rem; border-top: 1px solid rgba(255,255,255,0.1);">${v.reason}</div>
                `;
                verdictsContainer.appendChild(div);
            });
        }
    }

    function renderMonthlyTrends(data) {
        if (!document.getElementById('monthlySpendChart')) return;
        const trends = data.monthly_trends;
        const months = getSortedMonths(data); 
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
                        activateTab('tab-transactions');
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
                    const catList = (trends.categories && trends.categories[m]) ? trends.categories[m] : [];
                    const found = catList.find(c => c.name === catName);
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
                const catList = (trends.categories && trends.categories[m]) ? trends.categories[m] : [];
                catList.forEach(c => {
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
                        activateTab('tab-transactions');
                    }
                }
            }
        });
    }


    let catExplorerPieInstance = null;

    window.renderMonthlyCategoryChart = renderMonthlyCategoryChart;
    function renderMonthlyCategoryChart(data) {
        const catCanvas = document.getElementById('monthlyCategoryChart');
        if (!catCanvas) return;
        const catCtx = catCanvas.getContext('2d');
        if (monthlyCategoryChartInstance) {
            monthlyCategoryChartInstance.destroy();
            monthlyCategoryChartInstance = null;
        }

        const trends = data.monthly_trends || {};
        const months = getSortedMonths(data);
        if (!months || months.length === 0) return;

        // Top 7 categories overall
        const top7 = (data.categories || []).slice(0, 7).map(c => c.name);
        
        const palette = [
            '#8b5cf6', // Violet (Investments)
            '#ec4899', // Pink / Rose (Rent)
            '#10b981', // Emerald (Groceries)
            '#f59e0b', // Amber (Food & Dining)
            '#3b82f6', // Blue (Shopping)
            '#06b6d4', // Cyan (Transport)
            '#f43f5e', // Coral (Fun)
            '#64748b'  // Slate (Other)
        ];

        const datasets = [];
        top7.forEach((catName, index) => {
            datasets.push({
                label: catName,
                data: months.map(m => {
                    const catList = (trends.categories && trends.categories[m]) ? trends.categories[m] : [];
                    const found = catList.find(c => c.name === catName);
                    return found ? found.amount : 0;
                }),
                backgroundColor: palette[index % palette.length],
                borderRadius: 3,
                borderWidth: 0
            });
        });

        // Misc (aggregated other categories) bucket
        datasets.push({
            label: 'Misc',
            data: months.map(m => {
                let sum = 0;
                const catList = (trends.categories && trends.categories[m]) ? trends.categories[m] : [];
                catList.forEach(c => {
                    if (!top7.includes(c.name)) sum += c.amount;
                });
                return sum;
            }),
            backgroundColor: palette[7],
            borderRadius: 3,
            borderWidth: 0
        });

        monthlyCategoryChartInstance = new Chart(catCtx, {
            type: 'bar',
            data: { labels: months, datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        stacked: true,
                        grid: { display: false },
                        ticks: { color: '#94a3b8', font: { weight: 600 } }
                    },
                    y: {
                        stacked: true,
                        grid: { color: 'rgba(255,255,255,0.06)' },
                        ticks: {
                            color: '#94a3b8',
                            callback: value => '₹' + (value >= 1000 ? (value / 1000).toFixed(0) + 'k' : value)
                        }
                    }
                },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: '#f1f5f9', padding: 12, boxWidth: 12, usePointStyle: true }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return ` ${context.dataset.label}: ₹${Number(context.raw).toLocaleString('en-IN')}`;
                            },
                            footer: function(tooltipItems) {
                                let total = 0;
                                tooltipItems.forEach(item => { total += item.raw; });
                                return ` Total Month Spend: ₹${Number(total).toLocaleString('en-IN')}`;
                            }
                        }
                    }
                },
                onClick: (e, elements) => {
                    if (elements.length > 0) {
                        const el = elements[0];
                        const month = months[el.index];
                        const categoryName = datasets[el.datasetIndex].label;

                        const filterMonth = document.getElementById('filter-month');
                        const filterCat = document.getElementById('filter-category');
                        if (filterMonth) filterMonth.value = month;
                        if (filterCat) {
                            filterCat.value = (categoryName !== 'Misc' && categoryName !== 'Other') ? categoryName : 'All';
                        }
                        if (window.filterTransactions) window.filterTransactions();
                        activateTab('tab-transactions');
                    }
                }
            }
        });
    }

    function renderCategoryExplorerPie(catsToRender) {
        const canvas = document.getElementById('categoryExplorerPieChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (catExplorerPieInstance) {
            catExplorerPieInstance.destroy();
            catExplorerPieInstance = null;
        }

        const topCats = catsToRender.slice(0, 6);
        const otherAmt = catsToRender.slice(6).reduce((s, c) => s + c.amount, 0);
        
        const labels = topCats.map(c => c.name);
        const dataVals = topCats.map(c => c.amount);
        if (otherAmt > 0) {
            labels.push('Misc');
            dataVals.push(otherAmt);
        }

        const colors = [
            '#8b5cf6', '#ec4899', '#10b981', '#f59e0b', 
            '#3b82f6', '#06b6d4', '#64748b'
        ];

        catExplorerPieInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: dataVals,
                    backgroundColor: colors.slice(0, labels.length),
                    borderWidth: 2,
                    borderColor: '#0f172a'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: { color: '#f1f5f9', font: { size: 11 }, boxWidth: 12, usePointStyle: true }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(ctx) {
                                const val = ctx.raw;
                                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = total > 0 ? ((val / total) * 100).toFixed(1) : 0;
                                return ` ${ctx.label}: ₹${Number(val).toLocaleString('en-IN')} (${pct}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    function renderCategoryExplorer(data, selectedMonth = 'All') {
        const tbody = document.querySelector('#category-explorer-table tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        
        let catsToRender = [];
        if (selectedMonth === 'All') {
            catsToRender = data.categories;
        } else {
            // Compute monthly categories with count and average
            const monthTxs = data.transactions.filter(t => t.month_year === selectedMonth && t.type === 'Debit' && t.category !== 'Ignored/Refund');
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
            tr.innerHTML = `
                <td style="text-align: center;"><input type="checkbox" class="cat-explorer-checkbox" data-amount="${cat.amount}" checked></td>
                <td style="cursor: pointer;" class="cat-clickable">${cat.name}</td>
                <td style="cursor: pointer; font-weight:600;" class="cat-clickable">${formatCurrency(cat.amount)}</td>
                <td style="cursor: pointer;" class="cat-clickable">${cat.count}</td>
                <td style="cursor: pointer;" class="cat-clickable">${formatCurrency(cat.amount / cat.count)}</td>
                <td style="cursor: pointer;" class="cat-clickable">${cat.percent}%</td>
            `;
            
            tr.querySelector('.cat-explorer-checkbox').addEventListener('change', updateCatExplorerTotal);
            
            tr.querySelectorAll('.cat-clickable').forEach(el => {
                el.addEventListener('click', () => {
                    document.getElementById('filter-month').value = selectedMonth;
                    document.getElementById('filter-category').value = cat.name;
                    filterTransactions();
                    activateTab('tab-transactions');
                });
            });
            tbody.appendChild(tr);
        });

        updateCatExplorerTotal();
        renderCategoryExplorerPie(catsToRender);
        
        const selectAll = document.getElementById('cat-explore-select-all');
        if (selectAll) {
            selectAll.checked = true;
            selectAll.onclick = function() {
                document.querySelectorAll('.cat-explorer-checkbox').forEach(cb => cb.checked = this.checked);
                updateCatExplorerTotal();
        renderCategoryExplorerPie(catsToRender);
            };
        }
    }
    
    function updateCatExplorerTotal() {
        let total = 0;
        document.querySelectorAll('.cat-explorer-checkbox').forEach(cb => {
            if (cb.checked) total += parseFloat(cb.dataset.amount);
        });
        const totalEl = document.getElementById('cat-explorer-total');
        if (totalEl) totalEl.textContent = formatCurrency(total);
    }

    let filteredTxs = [];
    let filtersInitialized = false;
    let currentSortKey = null;
    let currentSortAsc = false;
    
    function applySort() {
        if (!currentSortKey) return;
        filteredTxs.sort((a, b) => {
            let valA = a[currentSortKey];
            let valB = b[currentSortKey];
            if (currentSortKey === 'amount') { valA = parseFloat(valA); valB = parseFloat(valB); }
            if (valA < valB) return -1;
            if (valA > valB) return 1;
            return 0;
        });
        if (!currentSortAsc) {
            filteredTxs.reverse();
        }
    }
    

    // --- SPEND INTELLIGENCE & INSIGHTS ---
    let fixedVsVarPieInstance = null;
    let spendVelocityChartInstance = null;

    window.renderSpendInsights = renderSpendInsights;
    function renderSpendInsights(data) {
        if (!data || !data.insights) return;
        const ins = data.insights;

        // 1. Category Surge / Spike Alerts
        const spikeContainer = document.getElementById('insights-spike-container');
        if (spikeContainer) {
            spikeContainer.innerHTML = '';
            const alerts = ins.spike_alerts || [];
            if (alerts.length === 0) {
                spikeContainer.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.5rem 0;">No abnormal category surges detected. All categories are tracking near historical averages.</div>';
            } else {
                alerts.slice(0, 8).forEach(a => {
                    const card = document.createElement('div');
                    card.style.cssText = 'background: rgba(239, 68, 68, 0.08); border-left: 3px solid var(--negative); padding: 0.5rem 0.75rem; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;';
                    card.innerHTML = `
                        <div>
                            <div style="font-weight: 600; font-size: 0.88rem; color: #f8fafc;">
                                <span>${a.category}</span>
                                <span style="font-size: 0.75rem; color: var(--accent); margin-left: 0.4rem; padding: 0.1rem 0.4rem; background: rgba(139,92,246,0.2); border-radius: 4px;">${a.month}</span>
                            </div>
                            <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 2px;">
                                Spent <strong>${formatCurrency(a.amount)}</strong> (Monthly avg: ${formatCurrency(a.avg)})
                            </div>
                        </div>
                        <span style="font-size: 0.8rem; font-weight: 700; color: #f87171; background: rgba(239,68,68,0.15); padding: 0.2rem 0.5rem; border-radius: 4px; white-space: nowrap;">
                            ▲ +${a.pct_change}%
                        </span>
                    `;
                    spikeContainer.appendChild(card);
                });
            }
        }

        // 3. Fixed Baseline vs. Controllable (Discretionary) Spend
        const fv = ins.fixed_vs_variable || {};
        const fixedPctEl = document.getElementById('insights-fixed-pct');
        if (fixedPctEl) fixedPctEl.textContent = `${fv.fixed_pct || 0}%`;

        const fixedAmtEl = document.getElementById('insights-fixed-amt');
        if (fixedAmtEl) fixedAmtEl.textContent = `${formatCurrency(fv.fixed_total || 0)} (~${formatCurrency(fv.fixed_monthly || 0)}/mo)`;

        const controlPctEl = document.getElementById('insights-control-pct');
        if (controlPctEl) controlPctEl.textContent = `${fv.control_pct || 0}%`;

        const controlAmtEl = document.getElementById('insights-control-amt');
        if (controlAmtEl) controlAmtEl.textContent = `${formatCurrency(fv.control_total || 0)} (~${formatCurrency(fv.control_monthly || 0)}/mo)`;

        // Pie chart for Fixed vs Variable
        const fvCanvas = document.getElementById('fixedVsVariablePieChart');
        if (fvCanvas) {
            if (fixedVsVarPieInstance) {
                fixedVsVarPieInstance.destroy();
                fixedVsVarPieInstance = null;
            }
            fixedVsVarPieInstance = new Chart(fvCanvas.getContext('2d'), {
                type: 'doughnut',
                data: {
                    labels: ['Fixed Commitments', 'Lifestyle / Controllable'],
                    datasets: [{
                        data: [fv.fixed_total || 0, fv.control_total || 0],
                        backgroundColor: ['#8b5cf6', '#38bdf8'],
                        borderWidth: 2,
                        borderColor: '#0f172a'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: ctx => ` ${ctx.label}: ₹${Number(ctx.raw).toLocaleString('en-IN')}`
                            }
                        }
                    }
                }
            });
        }

        
        // 5. Spend Velocity Curve (Day 1 to 31)
        const velCanvas = document.getElementById('spendVelocityChart');
        if (velCanvas && ins.spend_velocity) {
            if (spendVelocityChartInstance) {
                spendVelocityChartInstance.destroy();
                spendVelocityChartInstance = null;
            }
            const days = Array.from({ length: 31 }, (_, i) => `Day ${i + 1}`);
            const velColors = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#f43f5e', '#a855f7'];
            const velDatasets = Object.keys(ins.spend_velocity).map((m, idx) => ({
                label: m,
                data: ins.spend_velocity[m],
                borderColor: velColors[idx % velColors.length],
                backgroundColor: 'transparent',
                borderWidth: 2,
                pointRadius: 1,
                pointHoverRadius: 5,
                tension: 0.25
            }));

            spendVelocityChartInstance = new Chart(velCanvas.getContext('2d'), {
                type: 'line',
                data: { labels: days, datasets: velDatasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: {
                            grid: { color: 'rgba(255,255,255,0.04)' },
                            ticks: { color: '#94a3b8', maxTicksLimit: 16 }
                        },
                        y: {
                            grid: { color: 'rgba(255,255,255,0.06)' },
                            ticks: {
                                color: '#94a3b8',
                                callback: val => '₹' + (val >= 1000 ? (val / 1000).toFixed(0) + 'k' : val)
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: { color: '#f1f5f9', padding: 12, boxWidth: 12, usePointStyle: true }
                        },
                        tooltip: {
                            callbacks: {
                                label: ctx => ` ${ctx.dataset.label} (${ctx.label}): ₹${Number(ctx.raw).toLocaleString('en-IN')}`
                            }
                        }
                    }
                }
            });
        }

        
    }

    function setupTransactions(data) {
        filteredTxs = [...data.transactions];
        
        if (!filtersInitialized) {
            const catExplorerMonthSelect = document.getElementById('filter-cat-explorer-month');
            if (catExplorerMonthSelect) {
                catExplorerMonthSelect.addEventListener('change', (e) => {
                    renderCategoryExplorer(dashboardData, e.target.value);
                });
            }
        
            // Listeners for All Transactions
            const typeSelect = document.getElementById('filter-type');
            const monthSelect = document.getElementById('filter-month');
            const catSelect = document.getElementById('filter-category');
            if (typeSelect) typeSelect.addEventListener('change', filterTransactions);
            if (monthSelect) monthSelect.addEventListener('change', filterTransactions);
            if (catSelect) catSelect.addEventListener('change', filterTransactions);
            
            const txSearch = document.getElementById('tx-search');
            if (txSearch) txSearch.addEventListener('keyup', filterTransactions);
            
            const pagePrev = document.getElementById('page-prev');
            if (pagePrev) pagePrev.addEventListener('click', () => {
                if (currentTxPage > 1) { currentTxPage--; renderTxTable(); }
            });
            const pageNext = document.getElementById('page-next');
            if (pageNext) pageNext.addEventListener('click', () => {
                if (currentTxPage * TX_PER_PAGE < filteredTxs.length) { currentTxPage++; renderTxTable(); }
            });
            
            // Sorting for All Transactions
            document.querySelectorAll('#tx-table th[data-sort]').forEach(th => {
                th.addEventListener('click', () => {
                    const sortKey = th.getAttribute('data-sort');
                    if (currentSortKey === sortKey) {
                        currentSortAsc = !currentSortAsc;
                    } else {
                        currentSortKey = sortKey;
                        currentSortAsc = true;
                    }
                    
                    document.querySelectorAll('#tx-table th').forEach(el => el.classList.remove('asc'));
                    if (currentSortAsc) th.classList.add('asc');
                    
                    applySort();
                    currentTxPage = 1;
                    renderTxTable();
                });
            });
            filtersInitialized = true;
        }

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
                if (tx.category !== 'Ignored/Refund') {
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
        
        applySort();
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
                <td>
                    ${tx.type === 'Debit' ? `<button class="btn-primary" style="padding: 2px 6px; font-size: 0.75rem;" onclick="splitTransaction('${tx.tx_id}', ${tx.amount})">Split ✂️</button>` : ''}
                    <button class="btn-primary" style="padding: 2px 6px; font-size: 0.75rem; background: var(--accent); margin-left: 5px;" onclick="askAITransaction('${tx.merchant.replace(/'/g, "\\'")}', ${tx.amount}, '${tx.date}')">Ask AI 🤖</button>
                </td>
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
        if (t15 && data.top_15_overall) {
            t15.innerHTML = '';
            data.top_15_overall.forEach(tx => {
                t15.innerHTML += `<tr><td>${tx.date}</td><td>${tx.merchant}</td><td>${tx.category}</td><td class="debit">${formatCurrency(tx.amount)}</td></tr>`;
            });
        }
        
        // Frequent
        const freq = document.querySelector('#frequent-table tbody');
        if (freq && data.top_frequent) {
            freq.innerHTML = '';
            data.top_frequent.forEach(f => {
                freq.innerHTML += `<tr><td>${f.merchant}</td><td>${f.count}</td><td>${formatCurrency(f.amount)}</td></tr>`;
            });
        }
    }

        function renderSplits(data) {
        const tbody = document.querySelector('#splits-table tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        
        const splitTxs = data.transactions.filter(t => t.original_amount && t.original_amount !== t.amount);
        if (splitTxs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No split transactions yet. Go to Transactions tab and click "Split ✂️" on a payment.</td></tr>';
            return;
        }

        splitTxs.forEach(tx => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${tx.date}</td>
                <td>${tx.merchant}</td>
                <td style="color:var(--text-muted); text-decoration:line-through;">${formatCurrency(tx.original_amount)}</td>
                <td class="debit" style="font-weight:bold;">${formatCurrency(tx.amount)}</td>
                <td><button class="btn-primary" style="padding: 2px 6px; font-size: 0.75rem; background: var(--negative);" onclick="resetSplit('${tx.tx_id}', ${tx.original_amount})">Reset</button></td>
            `;
            tbody.appendChild(tr);
        });
    }

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

    // AI Assistant Logic
    const chatInput = document.getElementById('chat-input');
    const chatSendBtn = document.getElementById('chat-send-btn');
    const chatHistoryEl = document.getElementById('chat-history');
    let chatHistory = [];

    async function sendChatMessage() {
        const message = chatInput.value.trim();
        if (!message) return;
        if (!dashboardData) {
            alert('Please upload a statement first to use the assistant.');
            return;
        }

        // Add user message to UI
        const userMsgDiv = document.createElement('div');
        userMsgDiv.className = 'chat-message user';
        userMsgDiv.style = 'background: rgba(59, 130, 246, 0.2); padding: 0.8rem; border-radius: 8px; align-self: flex-end; max-width: 80%;';
        userMsgDiv.textContent = message;
        chatHistoryEl.appendChild(userMsgDiv);
        
        chatInput.value = '';
        chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;

        const originalBtnText = chatSendBtn.textContent;
        chatSendBtn.textContent = '...';
        chatSendBtn.disabled = true;

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: message,
                    history: chatHistory,
                    context_data: {
                        overview: dashboardData.overview,
                        transactions: dashboardData.transactions,
                        top_transactions: dashboardData.top_15_overall,
                        categories: dashboardData.categories,
                        top_merchants: dashboardData.top_frequent,
                        monthly_trends: dashboardData.monthly_trends,
                        month_verdicts: dashboardData.month_verdicts
                    }
                })
            });

            const data = await response.json();
            if (data.status === 'success') {
                chatHistory.push({ role: 'user', content: message });
                chatHistory.push({ role: 'model', content: data.reply });

                const botMsgDiv = document.createElement('div');
                botMsgDiv.className = 'chat-message bot';
                botMsgDiv.style = 'background: rgba(139,92,246,0.2); padding: 0.8rem; border-radius: 8px; align-self: flex-start; max-width: 80%;';
                // Very basic markdown handling for bold text
                botMsgDiv.innerHTML = data.reply.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
                chatHistoryEl.appendChild(botMsgDiv);
            } else {
                alert('Assistant Error: ' + data.message);
            }
        } catch (e) {
            console.error(e);
            alert('Failed to communicate with the assistant.');
        } finally {
            chatSendBtn.textContent = originalBtnText;
            chatSendBtn.disabled = false;
            chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
        }
    }

    window.askAITransaction = function(merchant, amount, date) {
        const tabBtn = document.querySelector('.tab-btn[data-target="tab-assistant"]');
        if (tabBtn) tabBtn.click();
        chatInput.value = `I see a transaction for "${merchant}" of ₹${amount} on ${date}. What sort of recharge or payment could this be?`;
        sendChatMessage();
    };

    if (chatSendBtn) chatSendBtn.addEventListener('click', sendChatMessage);
    if (chatInput) chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendChatMessage();
    });

    const clearSessionBtn = document.getElementById('clear-session-btn');
    if (clearSessionBtn) {
        clearSessionBtn.addEventListener('click', async () => {
            if (confirm("Are you sure you want to clear your data and start over?")) {
                await fetch('/api/clear-session', { method: 'POST' });
                window.location.reload();
            }
        });
    }

    // --- Toast Notifications ---
    function showToast(message, type = 'success') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        const icon = type === 'success' ? '✅' : (type === 'error' ? '⚠️' : 'ℹ️');
        toast.innerHTML = `<span style="font-size:1.1rem;">${icon}</span> <span>${message}</span>`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            setTimeout(() => toast.remove(), 400);
        }, 5500);
    }

    // --- Add Statement / Append Month Modal Logic ---
    const addStatementModal = document.getElementById('add-statement-modal');
    const addStatementBtn = document.getElementById('add-statement-btn');
    const closeAddModalBtn = document.getElementById('close-add-modal-btn');
    const cancelAddModalBtn = document.getElementById('cancel-add-modal-btn');
    const addStatementForm = document.getElementById('add-statement-form');

    function openAddModal() {
        if (!addStatementModal) return;
        addStatementModal.style.display = 'flex';
        
        if (addStatementForm) addStatementForm.reset();
        const fileList = document.getElementById('append-file-list');
        if (fileList) {
            fileList.style.display = 'none';
            fileList.innerHTML = '';
        }
        const msg = document.getElementById('append-file-msg');
        if (msg) {
            msg.textContent = 'Choose statement file (PDF, Excel, CSV)';
            msg.style.color = '';
        }
        const loadingState = document.getElementById('append-loading-state');
        if (loadingState) loadingState.style.display = 'none';
        if (addStatementForm) addStatementForm.style.display = 'block';

        const activeText = document.getElementById('modal-active-text');
        if (activeText && dashboardData && dashboardData.overview) {
            const o = dashboardData.overview;
            const count = o.months_count || (o.months_list ? o.months_list.length : 1);
            const period = o.period_str ? ` (${o.period_str})` : '';
            const txs = o.tx_count || (dashboardData.transactions ? dashboardData.transactions.length : 0);
            activeText.textContent = `Active Analysis: ${count} Months${period} • ${txs} Transactions`;
        }
    }

    function closeAddModal() {
        if (addStatementModal) addStatementModal.style.display = 'none';
    }

    if (addStatementBtn) addStatementBtn.addEventListener('click', openAddModal);
    if (closeAddModalBtn) closeAddModalBtn.addEventListener('click', closeAddModal);
    if (cancelAddModalBtn) cancelAddModalBtn.addEventListener('click', closeAddModal);

    // Any button with .open-add-modal-btn opens the modal
    document.querySelectorAll('.open-add-modal-btn').forEach(btn => {
        btn.addEventListener('click', openAddModal);
    });

    // Global document event delegation as a bulletproof fallback
    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest && e.target.closest('.open-add-modal-btn, #add-statement-btn, .btn-add-statement');
        if (btn) {
            e.preventDefault();
            openAddModal();
        }
    });

    // Close on outside click
    if (addStatementModal) {
        addStatementModal.addEventListener('click', (e) => {
            if (e.target === addStatementModal) closeAddModal();
        });
    }

    window.openAddModal = openAddModal;
    window.closeAddModal = closeAddModal;

    // Append statement form submit
    if (addStatementForm) {
        addStatementForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fileInput = document.getElementById('append-bank-statement');
            if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
                alert('Please select at least one statement file.');
                return;
            }

            const loadingState = document.getElementById('append-loading-state');
            addStatementForm.style.display = 'none';
            loadingState.style.display = 'block';

            const formData = new FormData();
            for (let i = 0; i < fileInput.files.length; i++) {
                formData.append('bank_statements', fileInput.files[i]);
            }
            formData.append('bank_statement', fileInput.files[0]);

            const note = document.getElementById('append-context-note').value;
            if (note) formData.append('context_note', note);

            try {
                const response = await fetch('/api/append-statement', {
                    method: 'POST',
                    body: formData
                });
                const result = await response.json();
                if (result.status === 'success') {
                    dashboardData = result.data;
                    renderDashboard(dashboardData);
                    closeAddModal();

                    const added = result.added_count;
                    const total = result.total_count;
                    const months = result.months_count;
                    if (added === 0) {
                        showToast(`No new transactions found — all transactions in the uploaded statement were already present in your dataset. No duplicates added.`, 'info');
                    } else {
                        showToast(`🎉 Added ${added} new transactions! You now have ${months} months (${total} total transactions) in your dashboard.`, 'success');
                    }
                } else {
                    alert('Error: ' + result.message);
                    addStatementForm.style.display = 'block';
                    loadingState.style.display = 'none';
                }
            } catch (err) {
                console.error(err);
                alert('Failed to append statement. See console for details.');
                addStatementForm.style.display = 'block';
                loadingState.style.display = 'none';
            }
        });
    }
});
