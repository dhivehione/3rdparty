        let authToken = Auth.getToken();
        let allSignups = [];
        let currentPage = 1;
        let totalPages = 1;
        const PAGE_SIZE = 50;

        if (authToken) {
            showDashboard();
        }

        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('password').value;
            
            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    authToken = result.token;
                    Auth.setToken(authToken);
                    showDashboard();
                } else {
                    document.getElementById('loginError').classList.remove('hidden');
                    document.getElementById('loginError').textContent = result.error;
                }
            } catch (error) {
                document.getElementById('loginError').classList.remove('hidden');
                document.getElementById('loginError').textContent = 'Connection error';
            }
        });

        function showDashboard() {
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('dashboard').classList.remove('hidden');
            refreshData();
            loadProposalsAdmin();
            loadPendingDonations();
            loadTreasuryLedger();
            loadAdminEvents();
        }

        function logout() {
            Auth.clearToken();
            authToken = null;
            document.getElementById('dashboard').classList.add('hidden');
            document.getElementById('loginScreen').classList.remove('hidden');
            document.getElementById('password').value = '';
        }

        async function refreshData() {
            try {
                const response = await fetch(`/api/signups?page=${currentPage}&limit=${PAGE_SIZE}`, {
                    headers: Auth.getApiHeaders()
                });
                
                if (!response.ok) {
                    logout();
                    return;
                }
                
                const result = await response.json();
                
                if (result.success) {
                    allSignups = result.signups;
                    totalPages = result.totalPages || 1;
                    updateStats(result);
                    applyFilter();
                    renderPagination();
                    await loadLeadershipData();
                } else {
                    logout();
                }
            } catch (error) {
                console.error('Error fetching data:', error);
            }
        }

        function updateStats(result) {
            document.getElementById('totalCount').textContent = result.total.toLocaleString();
            document.getElementById('totalTreasury').textContent = `MVR ${result.total_treasury.toLocaleString()}`;
            document.getElementById('todayCount').textContent = result.today_count || 0;
            document.getElementById('donorCount').textContent = result.donor_count || 0;
        }

        function applyFilter() {
            const filterType = document.getElementById('filterType').value;
            const filterStatus = document.getElementById('filterStatus').value;
            const searchTerm = document.getElementById('searchInput').value.toLowerCase();
            
            let filtered = allSignups;
            
            if (filterType !== 'all') {
                filtered = filtered.filter(s => {
                    const types = Array.isArray(s.contribution_type) ? s.contribution_type : [];
                    return types.includes(filterType);
                });
            }
            
            if (filterStatus !== 'all') {
                if (filterStatus === 'verified') {
                    filtered = filtered.filter(s => s.is_verified === 1);
                } else {
                    filtered = filtered.filter(s => s.is_verified === 0);
                }
            }
            
            if (searchTerm) {
                filtered = filtered.filter(s =>
                    (s.name && s.name.toLowerCase().includes(searchTerm)) ||
                    (s.phone && s.phone.includes(searchTerm)) ||
                    (s.nid && s.nid.toLowerCase().includes(searchTerm))
                );
            }
            
            renderTable(filtered);
        }

        const typeLabels = {
            'skills': '🧠 Skills',
            'action': '🏃 Action',
            'ideas': '💡 Ideas',
            'donation': '💰 Donation'
        };

        function renderTable(signups) {
            const tbody = document.getElementById('signupsTableBody');
            const noData = document.getElementById('noData');
            
            if (signups.length === 0) {
                tbody.innerHTML = '';
                noData.classList.remove('hidden');
                return;
            }
            
            noData.classList.add('hidden');
            
                tbody.innerHTML = signups.map(s => `
                <tr class="hover:bg-gray-800/50 text-sm ${s.is_verified ? '' : 'opacity-50'}">
                    <td class="px-6 py-4 text-gray-500">#${s.id}</td>
                    <td class="px-6 py-4">${s.phone ? '+960 ' + s.phone : '<span class="text-gray-600">—</span>'}</td>
                    <td class="px-6 py-4 font-mono">${s.nid || '<span class="text-gray-600">—</span>'}</td>
                    <td class="px-6 py-4">${s.name || '<span class="text-gray-600">—</span>'}</td>
                    <td class="px-6 py-4">
                        ${s.is_verified 
                            ? '<span class="bg-green-500/10 text-green-400 px-2 py-1 rounded text-xs">Verified</span>'
                            : `<span class="bg-red-500/10 text-red-400 px-2 py-1 rounded text-xs">Unregistered</span>
                               <div class="text-xs text-gray-500 mt-1">${s.unregister_justification || ''}</div>`
                        }
                    </td>
                    <td class="px-6 py-4">
                        ${(Array.isArray(s.contribution_type) ? s.contribution_type : []).map(t => 
                            `<span class="bg-party-accent/10 text-party-accent px-2 py-1 rounded text-xs mr-1">${typeLabels[t] || t}</span>`
                        ).join('')}
                        ${(!s.contribution_type || s.contribution_type.length === 0) ? '<span class="text-gray-500">Supporter</span>' : ''}
                    </td>
                    <td class="px-6 py-4">
                        ${s.donation_amount > 0 ? `<span class="text-green-400">MVR ${s.donation_amount}</span>` : '<span class="text-gray-600">—</span>'}
                    </td>
                    <td class="px-6 py-4">
                        <span class="text-party-accent font-bold">${s.initial_merit_estimate}</span>
                    </td>
                    <td class="px-6 py-4 text-gray-400 text-xs">
                        ${new Date(s.timestamp).toLocaleString()}
                    </td>
                    <td class="px-6 py-4">
                        ${s.is_verified 
                            ? `<button onclick="unregisterUser(${s.id})" class="text-red-400 hover:text-red-300 text-sm">
                                <i class="fas fa-user-minus mr-1"></i>Unregister
                               </button>`
                            : `<button onclick="reregisterUser(${s.id})" class="text-green-400 hover:text-green-300 text-sm">
                                <i class="fas fa-user-plus mr-1"></i>Re-register
                               </button>`
                        }
                    </td>
                </tr>
            `).join('');
        }

        async function exportToCSV() {
            try {
                const response = await fetch('/api/signups?limit=999999', {
                    headers: Auth.getApiHeaders()
                });
                const result = await response.json();
                if (!result.success) {
                    alert('Failed to fetch data for export');
                    return;
                }
                const allData = result.signups;
                
                let csv = 'ID,Phone,NID,Name,Email,Island,Verified,Contribution Type,Donation Amount,Initial Merit,Unregistered,Unregister Justification,Timestamp\n';
                
                allData.forEach(s => {
                    const types = Array.isArray(s.contribution_type) ? s.contribution_type.join(';') : '';
                    csv += `${s.id},${s.phone ? '+960' + s.phone : ''},${s.nid || ''},"${s.name || ''}","${s.email || ''}","${s.island || ''}",${s.is_verified ? 'Yes' : 'No'},"${types}",${s.donation_amount},${s.initial_merit_estimate},${s.unregistered_at ? 'Yes' : 'No'},"${s.unregister_justification || ''}","${s.timestamp}"\n`;
                });
                
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `3dparty-signups-${new Date().toISOString().split('T')[0]}.csv`;
                a.click();
            } catch (error) {
                alert('Error exporting CSV');
            }
        }

        async function unregisterUser(userId) {
            if (!authToken) {
                alert('Session expired. Please login again.');
                logout();
                return;
            }

            const justification = prompt('Enter justification for unregistering this user (required):');
            
            if (!justification || justification.trim().length < 10) {
                alert('Justification note must be at least 10 characters.');
                return;
            }
            
            if (!confirm('This will remove the user\'s verified status. Continue?')) return;
            
            try {
                const response = await fetch('/api/unregister', {
                    method: 'POST',
                    headers: Auth.getApiHeaders(),
                    body: JSON.stringify({ user_id: userId, justification: justification.trim() })
                });
                
                if (!response.ok) {
                    alert('Server error. Please try again.');
                    return;
                }
                
                const result = await response.json();
                if (result.success) {
                    alert(result.message);
                    await refreshData();
                } else {
                    alert(result.error || 'Failed to unregister user');
                }
            } catch (error) {
                alert('Error unregistering user');
            }
        }

        async function reregisterUser(userId) {
            if (!authToken) {
                alert('Session expired. Please login again.');
                logout();
                return;
            }
            
            if (!confirm('Re-register this user? This will restore their verified status.')) return;
            
            try {
                const response = await fetch('/api/reregister', {
                    method: 'POST',
                    headers: Auth.getApiHeaders(),
                    body: JSON.stringify({ user_id: userId })
                });
                
                if (!response.ok) {
                    alert('Server error. Please try again.');
                    return;
                }
                
                const result = await response.json();
                if (result.success) {
                    alert(result.message);
                    await refreshData();
                } else {
                    alert(result.error || 'Failed to re-register user');
                }
            } catch (error) {
                alert('Error re-registering user');
            }
        }

        // ==================== PAGINATION ====================
        function renderPagination() {
            const pageInfo = document.getElementById('pageInfo');
            const pageButtons = document.getElementById('pageButtons');
            
            if (!totalPages || totalPages <= 1) {
                pageInfo.textContent = `Showing all ${allSignups.length} members`;
                pageButtons.innerHTML = '';
                return;
            }
            
            const start = (currentPage - 1) * PAGE_SIZE + 1;
            const end = Math.min(currentPage * PAGE_SIZE, allSignups.length + (currentPage - 1) * PAGE_SIZE);
            pageInfo.textContent = `Page ${currentPage} of ${totalPages} (${allSignups.length} members on this page)`;
            
            let buttonsHtml = '';
            
            // Previous button
            buttonsHtml += `<button onclick="goToPage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''} 
                class="px-3 py-1 rounded ${currentPage <= 1 ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-700 text-white hover:bg-gray-600'}">
                <i class="fas fa-chevron-left"></i>
            </button>`;
            
            // Page numbers
            const maxVisible = 5;
            let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
            let endPage = Math.min(totalPages, startPage + maxVisible - 1);
            if (endPage - startPage < maxVisible - 1) {
                startPage = Math.max(1, endPage - maxVisible + 1);
            }
            
            if (startPage > 1) {
                buttonsHtml += `<button onclick="goToPage(1)" class="px-3 py-1 rounded bg-gray-700 text-white hover:bg-gray-600">1</button>`;
                if (startPage > 2) {
                    buttonsHtml += `<span class="text-gray-500">...</span>`;
                }
            }
            
            for (let i = startPage; i <= endPage; i++) {
                if (i === currentPage) {
                    buttonsHtml += `<button class="px-3 py-1 rounded bg-party-accent text-party-dark font-bold">${i}</button>`;
                } else {
                    buttonsHtml += `<button onclick="goToPage(${i})" class="px-3 py-1 rounded bg-gray-700 text-white hover:bg-gray-600">${i}</button>`;
                }
            }
            
            if (endPage < totalPages) {
                if (endPage < totalPages - 1) {
                    buttonsHtml += `<span class="text-gray-500">...</span>`;
                }
                buttonsHtml += `<button onclick="goToPage(${totalPages})" class="px-3 py-1 rounded bg-gray-700 text-white hover:bg-gray-600">${totalPages}</button>`;
            }
            
            // Next button
            buttonsHtml += `<button onclick="goToPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''} 
                class="px-3 py-1 rounded ${currentPage >= totalPages ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-700 text-white hover:bg-gray-600'}">
                <i class="fas fa-chevron-right"></i>
            </button>`;
            
            pageButtons.innerHTML = buttonsHtml;
        }

        async function goToPage(page) {
            if (page < 1 || page > totalPages) return;
            currentPage = page;
            await refreshData();
        }

        // Keyboard shortcut: Ctrl+R to refresh
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'r') {
                e.preventDefault();
                refreshData();
            }
        });

        // ==================== LEADERSHIP MANAGEMENT ====================
        
        let leadershipData = {
            settings: {},
            positions: [],
            applications: [],
            terms: [],
            sops: []
        };

        async function loadLeadershipData() {
            try {
                const [settingsRes, posRes, appRes, termsRes, sopsRes] = await Promise.all([
                    fetch('/api/leadership/settings', { headers: Auth.getApiHeaders() }),
                    fetch('/api/leadership/positions', { headers: Auth.getApiHeaders() }),
                    fetch('/api/leadership/applications', { headers: Auth.getApiHeaders() }),
                    fetch('/api/leadership/terms', { headers: Auth.getApiHeaders() }),
                    fetch('/api/leadership/sops', { headers: Auth.getApiHeaders() })
                ]);
                
                const settings = await settingsRes.json();
                const positions = await posRes.json();
                const applications = await appRes.json();
                const terms = await termsRes.json();
                const sops = await sopsRes.json();
                
                if (settings.success) {
                    leadershipData.settings = settings.settings;
                    leadershipData.memberCount = settings.memberCount;
                    
                    document.getElementById('leadershipThresholdInput').value = settings.settings.member_threshold;
                    document.getElementById('leadershipMinMerit').value = settings.settings.min_merit_for_leadership;
                    document.getElementById('leadershipMaxTerm').value = settings.settings.max_term_years;
                    document.getElementById('leadershipAppraisalFreq').value = settings.settings.appraisal_frequency_days;
                    document.getElementById('leadershipThreshold').textContent = `Threshold: ${settings.settings.member_threshold}`;
                    
                    const thresholdMet = settings.memberCount >= settings.settings.member_threshold;
                    const statusEl = document.getElementById('leadershipStatus');
                    if (thresholdMet) {
                        statusEl.textContent = 'OPEN';
                        statusEl.className = 'text-2xl font-bold text-green-400';
                    } else {
                        statusEl.textContent = `${settings.memberCount}/${settings.settings.member_threshold}`;
                        statusEl.className = 'text-2xl font-bold text-yellow-400';
                    }
                    
                    document.getElementById('openPositions').textContent = positions.positions.filter(p => p.is_active).length;
                    document.getElementById('pendingApps').textContent = applications.applications.filter(a => a.status === 'pending').length;
                    document.getElementById('activeLeaders').textContent = terms.terms.length;
                    document.getElementById('activeSOPs').textContent = sops.sops.length;
                }
                
                if (positions.success) leadershipData.positions = positions.positions;
                if (applications.success) leadershipData.applications = applications.applications;
                if (terms.success) leadershipData.terms = terms.terms;
                if (sops.success) leadershipData.sops = sops.sops;
                
            } catch (error) {
                console.error('Error loading leadership data:', error);
            }
        }

        function showLeadershipTab(tab) {
            document.getElementById('leadershipPanel').classList.remove('hidden');
            switchLeadershipTab(tab);
            loadLeadershipData();
        }

        function switchLeadershipTab(tab) {
            document.querySelectorAll('.leadership-tab').forEach(t => {
                t.classList.remove('text-party-accent', 'border-b-2', 'border-party-accent');
                t.classList.add('text-gray-400');
            });
            document.querySelector(`.leadership-tab[data-tab="${tab}"]`).classList.add('text-party-accent', 'border-b-2', 'border-party-accent');
            document.querySelectorAll('.leadership-tab[data-tab="' + tab + '"]').forEach(t => t.classList.remove('text-gray-400'));
            
            document.querySelectorAll('.leadership-content').forEach(c => c.classList.add('hidden'));
            document.getElementById(`leadership-${tab}`).classList.remove('hidden');
            
            renderLeadershipContent(tab);
        }

        function renderLeadershipContent(tab) {
            switch(tab) {
                case 'positions': renderPositions(); break;
                case 'applications': renderApplications(); break;
                case 'leaders': renderLeaders(); break;
                case 'sops': renderSOPs(); break;
                case 'appraisals': renderAppraisals(); break;
            }
        }

        function renderPositions() {
            const container = document.getElementById('positionsList');
            if (leadershipData.positions.length === 0) {
                container.innerHTML = '<p class="text-gray-500">No positions defined</p>';
                return;
            }
            
            container.innerHTML = leadershipData.positions.map(p => `
                <div class="flex justify-between items-center p-4 bg-gray-800/50 rounded-lg">
                    <div>
                        <div class="font-bold text-white">${p.title}</div>
                        <div class="text-sm text-gray-400">${p.description || ''}</div>
                        <div class="text-xs text-gray-500 mt-1">
                            <span class="px-2 py-0.5 rounded ${p.position_type === 'council' ? 'bg-purple-500/20 text-purple-400' : p.position_type === 'committee' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-500/20 text-gray-400'}">${p.position_type}</span>
                            <span class="ml-2">Min Merit: ${p.min_merit_required}</span>
                            <span class="ml-2">Current: ${p.current_holders || 0}</span>
                        </div>
                    </div>
                    <button onclick="togglePosition(${p.id}, ${p.is_active})" class="text-sm ${p.is_active ? 'text-green-400' : 'text-gray-500'}">
                        <i class="fas fa-${p.is_active ? 'toggle-on' : 'toggle-off'}"></i>
                    </button>
                </div>
            `).join('');
        }

        function renderApplications() {
            const container = document.getElementById('applicationsList');
            const pending = leadershipData.applications.filter(a => a.status === 'pending');
            const other = leadershipData.applications.filter(a => a.status !== 'pending');
            
            let html = '<h4 class="font-bold text-party-accent mb-3">Pending Review (' + pending.length + ')</h4>';
            if (pending.length === 0) {
                html += '<p class="text-gray-500 mb-4">No pending applications</p>';
            } else {
                html += pending.map(a => `
                    <div class="p-4 bg-gray-800/50 rounded-lg mb-4">
                        <div class="flex justify-between">
                            <div>
                                <div class="font-bold">${a.name || 'Member #' + a.user_id}</div>
                                <div class="text-sm text-gray-400">Applied for: ${a.position_title}</div>
                                <div class="text-xs text-gray-500">Merit Score: ${a.merit_score}</div>
                                <div class="text-xs text-gray-500">Applied: ${new Date(a.applied_at).toLocaleDateString()}</div>
                            </div>
                            <div class="flex flex-col gap-2">
                                <button onclick="processApplication(${a.id}, 'interview')" class="bg-blue-600 text-white px-3 py-1 rounded text-xs">Schedule Interview</button>
                                <button onclick="processApplication(${a.id}, 'approved')" class="bg-green-600 text-white px-3 py-1 rounded text-xs">Approve</button>
                                <button onclick="processApplication(${a.id}, 'rejected')" class="bg-red-600 text-white px-3 py-1 rounded text-xs">Reject</button>
                            </div>
                        </div>
                        <div class="mt-3 p-3 bg-gray-900/50 rounded text-sm text-gray-300">${a.application_text}</div>
                        ${a.status === 'interview' ? '<div class="mt-2 text-blue-400 text-xs"><i class="fas fa-video mr-1"></i>Live public interview scheduled</div>' : ''}
                    </div>
                `).join('');
            }
            
            if (other.length > 0) {
                html += '<h4 class="font-bold text-gray-400 mt-6 mb-3">Processed Applications</h4>';
                html += other.map(a => `
                    <div class="flex justify-between items-center p-3 bg-gray-800/30 rounded-lg text-sm">
                        <div>
                            <span class="text-gray-300">${a.name || 'Member #' + a.user_id}</span>
                            <span class="text-gray-500"> - ${a.position_title}</span>
                        </div>
                        <span class="px-2 py-1 rounded text-xs ${a.status === 'approved' ? 'bg-green-500/20 text-green-400' : a.status === 'rejected' ? 'bg-red-500/20 text-red-400' : 'bg-blue-500/20 text-blue-400'}">${a.status}</span>
                    </div>
                `).join('');
            }
            
            container.innerHTML = html;
        }

        function renderLeaders() {
            const container = document.getElementById('leadersList');
            if (leadershipData.terms.length === 0) {
                container.innerHTML = '<p class="text-gray-500">No active leadership. Applications open at ' + leadershipData.settings.member_threshold + ' members.</p>';
                return;
            }
            
            container.innerHTML = leadershipData.terms.map(t => `
                <div class="flex justify-between items-center p-4 bg-gray-800/50 rounded-lg">
                    <div>
                        <div class="font-bold text-white">${t.name || 'Leader #' + t.user_id}</div>
                        <div class="text-sm text-party-accent">${t.position_title}</div>
                        <div class="text-xs text-gray-500">
                            Term ${t.term_number} since ${new Date(t.started_at).toLocaleDateString()} | Merit: ${t.merit_score}
                        </div>
                    </div>
                    <div class="flex gap-2">
                        <button onclick="showAppraisalForm(${t.id}, '${t.name}', '${t.position_title}')" class="text-party-accent hover:text-white text-sm">
                            <i class="fas fa-star mr-1"></i>Appraise
                        </button>
                        <button onclick="endTerm(${t.id})" class="text-red-400 hover:text-red-300 text-sm">
                            <i class="fas fa-user-minus mr-1"></i>End Term
                        </button>
                    </div>
                </div>
            `).join('');
        }

        function renderSOPs() {
            const container = document.getElementById('sopsList');
            if (leadershipData.sops.length === 0) {
                container.innerHTML = '<p class="text-gray-500">No SOPs defined</p>';
                return;
            }
            
            const byCategory = {};
            leadershipData.sops.forEach(s => {
                if (!byCategory[s.category]) byCategory[s.category] = [];
                byCategory[s.category].push(s);
            });
            
            container.innerHTML = Object.entries(byCategory).map(([cat, sops]) => `
                <div class="mb-4">
                    <h4 class="font-bold text-party-accent capitalize mb-2">${cat} Operations</h4>
                    ${sops.map(s => `
                        <div class="p-3 bg-gray-800/50 rounded-lg mb-2">
                            <div class="flex justify-between items-start">
                                <div class="font-medium text-white">${s.title}</div>
                                <button onclick="editSOP(${s.id})" class="text-gray-500 hover:text-white"><i class="fas fa-edit"></i></button>
                            </div>
                            <div class="text-sm text-gray-400 mt-1">${s.content.substring(0, 150)}...</div>
                            <div class="text-xs text-gray-500 mt-1">v${s.version} | Updated: ${new Date(s.updated_at).toLocaleDateString()}</div>
                        </div>
                    `).join('')}
                </div>
            `).join('');
        }

        function renderAppraisals() {
            const container = document.getElementById('appraisalsList');
            container.innerHTML = '<p class="text-gray-400">Use the "Appraise" button on current leaders to record yearly performance reviews.</p>';
        }

        async function saveLeadershipSettings() {
            const data = {
                member_threshold: parseInt(document.getElementById('leadershipThresholdInput').value),
                min_merit_for_leadership: parseInt(document.getElementById('leadershipMinMerit').value),
                max_term_years: parseInt(document.getElementById('leadershipMaxTerm').value),
                appraisal_frequency_days: parseInt(document.getElementById('leadershipAppraisalFreq').value)
            };
            
            try {
                const res = await fetch('/api/leadership/settings', {
                    method: 'POST',
                    headers: Auth.getApiHeaders(),
                    body: JSON.stringify(data)
                });
                const result = await res.json();
                if (result.success) {
                    alert('Settings saved!');
                    loadLeadershipData();
                } else {
                    alert('Error: ' + result.error);
                }
            } catch (error) {
                alert('Failed to save settings');
            }
        }

        async function processApplication(id, status) {
            if (!confirm('Update application status to: ' + status + '?')) return;
            
            try {
                const res = await fetch('/api/leadership/applications/' + id + '/status', {
                    method: 'POST',
                    headers: Auth.getApiHeaders(),
                    body: JSON.stringify({ status })
                });
                const result = await res.json();
                if (result.success) {
                    alert('Application ' + status);
                    loadLeadershipData();
                } else {
                    alert('Error: ' + result.error);
                }
            } catch (error) {
                alert('Failed to process application');
            }
        }

        async function endTerm(id) {
            if (!confirm('End this leadership term? This action cannot be undone.')) return;
            
            try {
                const res = await fetch('/api/leadership/terms/' + id + '/end', {
                    method: 'POST',
                    headers: Auth.getApiHeaders(),
                    body: JSON.stringify({ reason: 'Ended by admin' })
                });
                const result = await res.json();
                if (result.success) {
                    alert('Term ended');
                    loadLeadershipData();
                } else {
                    alert('Error: ' + result.error);
                }
            } catch (error) {
                alert('Failed to end term');
            }
        }

        async function togglePosition(id, currentState) {
            // For now, just reload - would need endpoint to toggle
            alert('Position toggle - reload to see changes');
        }

        function showAddPositionForm() {
            const title = prompt('Position Title:');
            if (!title) return;
            const desc = prompt('Description:') || '';
            const type = prompt('Type (council/committee/hub/advisory):') || 'council';
            const merit = parseInt(prompt('Minimum Merit Required:') || '500');
            
            // Would call API here
            alert('Position creation endpoint ready');
        }

        function showAddSOPForm() {
            const title = prompt('SOP Title:');
            if (!title) return;
            const content = prompt('SOP Content:') || '';
            const category = prompt('Category (operations/governance/finance/accountability):') || 'operations';
            
            // Would call API here
            alert('SOP creation endpoint ready');
        }

        function editSOP(id) {
            const sop = leadershipData.sops.find(s => s.id === id);
            if (!sop) return;
            
            const newContent = prompt('Update SOP Content:', sop.content);
            if (newContent === null) return;
            
            // Would call API here
            alert('SOP update endpoint ready');
        }

        function showAppraisalForm(termId, name, position) {
            const rating = prompt('Rating (1-5) for ' + name + ' (' + position + '):');
            if (!rating) return;
            const feedback = prompt('Overall Feedback:') || '';
            
            const data = {
                term_id: termId,
                appraisal_period: new Date().toISOString().split('T')[0],
                rating: parseInt(rating),
                overall_feedback: feedback
            };
            
            // Would call API here
            alert('Appraisal saved for ' + name);
        }

        // ==================== PROPOSALS MANAGEMENT ====================
        async function loadProposalsAdmin() {
            const container = document.getElementById('proposalsAdminList');
            container.innerHTML = '<div class="text-center py-8 text-gray-500"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

            try {
                const res = await fetch('/api/admin/proposals', {
                    headers: Auth.getApiHeaders()
                });
                const data = await res.json();

                if (data.success && data.proposals) {
                    container.innerHTML = data.proposals.map(p => `
                        <div class="bg-party-card border border-gray-700 p-4 rounded-xl">
                            <div class="flex justify-between items-start mb-2">
                                <div>
                                    <h3 class="font-bold ${p.status === 'approved' ? 'text-green-400' : p.status === 'rejected' ? 'text-red-400' : 'text-white'}">${Utils.escapeHtml(p.title)}</h3>
                                    <span class="text-xs text-gray-400">${Utils.escapeHtml(p.category)} | ${p.status} | ${new Date(p.created_at).toLocaleDateString()}</span>
                                </div>
                                <span class="text-xs px-2 py-1 rounded ${getStatusColor(p.status)}">${p.status}</span>
                            </div>
                            <p class="text-gray-400 text-sm mb-3">${Utils.escapeHtml(p.description.substring(0, 150))}${p.description.length > 150 ? '...' : ''}</p>
                            <div class="flex flex-wrap gap-2">
                                <button onclick="openEditProposal(${p.id}, '${encodeURIComponent(p.title)}', '${encodeURIComponent(p.description)}', '${encodeURIComponent(p.category)}')" class="bg-blue-500/20 text-blue-400 px-3 py-1 rounded text-sm hover:bg-blue-500/30">
                                    <i class="fas fa-edit mr-1"></i>Edit
                                </button>
                                ${p.status === 'active' ? `
                                    <button onclick="updateProposalStatus(${p.id}, 'approved')" class="bg-green-500/20 text-green-400 px-3 py-1 rounded text-sm hover:bg-green-500/30">
                                        <i class="fas fa-check mr-1"></i>Approve
                                    </button>
                                    <button onclick="updateProposalStatus(${p.id}, 'rejected')" class="bg-red-500/20 text-red-400 px-3 py-1 rounded text-sm hover:bg-red-500/30">
                                        <i class="fas fa-times mr-1"></i>Reject
                                    </button>
                                    <button onclick="updateProposalStatus(${p.id}, 'postponed')" class="bg-yellow-500/20 text-yellow-400 px-3 py-1 rounded text-sm hover:bg-yellow-500/30">
                                        <i class="fas fa-pause mr-1"></i>Postpone
                                    </button>
                                ` : `
                                    <button onclick="updateProposalStatus(${p.id}, 'active')" class="bg-gray-700 text-gray-300 px-3 py-1 rounded text-sm hover:bg-gray-600">
                                        <i class="fas fa-undo mr-1"></i>Re-open
                                    </button>
                                `}
                            </div>
                        </div>
                    `).join('');
                } else {
                    container.innerHTML = '<div class="text-center py-8 text-gray-500">No proposals found.</div>';
                }
            } catch (err) {
                container.innerHTML = '<div class="text-center py-8 text-red-400">Error loading proposals.</div>';
            }
        }

        function getStatusColor(status) {
            switch(status) {
                case 'approved': return 'bg-green-500/20 text-green-400';
                case 'rejected': return 'bg-red-500/20 text-red-400';
                case 'postponed': return 'bg-yellow-500/20 text-yellow-400';
                default: return 'bg-gray-700 text-gray-400';
            }
        }

        async function updateProposalStatus(proposalId, status) {
            const feedback = status === 'rejected' ? prompt('Reason for rejection:') : '';

            try {
                const res = await fetch(`/api/admin/proposals/${proposalId}/status`, {
                    method: 'POST',
                    headers: Auth.getApiHeaders(),
                    body: JSON.stringify({ status, feedback })
                });
                const data = await res.json();

                if (data.success) {
                    alert('Proposal ' + status + '!');
                    loadProposalsAdmin();
                } else {
                    alert(data.error || 'Failed to update');
                }
            } catch (err) {
                alert('Network error');
            }
        }

        // ==================== PROPOSAL EDITING ====================
        function openEditProposal(id, title, description, category) {
            document.getElementById('editProposalId').value = id;
            document.getElementById('editProposalTitle').value = decodeURIComponent(title);
            document.getElementById('editProposalDescription').value = decodeURIComponent(description);
            document.getElementById('editProposalCategory').value = decodeURIComponent(category);
            document.getElementById('editProposalError').classList.add('hidden');
            document.getElementById('editProposalModal').classList.remove('hidden');
        }

        function closeEditModal() {
            document.getElementById('editProposalModal').classList.add('hidden');
        }

        document.getElementById('editProposalForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = document.getElementById('editProposalId').value;
            const title = document.getElementById('editProposalTitle').value.trim();
            const description = document.getElementById('editProposalDescription').value.trim();
            const category = document.getElementById('editProposalCategory').value;

            if (title.length < 5) {
                document.getElementById('editProposalError').textContent = 'Title must be at least 5 characters';
                document.getElementById('editProposalError').classList.remove('hidden');
                return;
            }

            if (description.length < 20) {
                document.getElementById('editProposalError').textContent = 'Description must be at least 20 characters';
                document.getElementById('editProposalError').classList.remove('hidden');
                return;
            }

            try {
                const res = await fetch(`/api/admin/proposals/${id}`, {
                    method: 'PUT',
                    headers: Auth.getApiHeaders(),
                    body: JSON.stringify({ title, description, category })
                });
                const data = await res.json();

                if (data.success) {
                    closeEditModal();
                    loadProposalsAdmin();
                } else {
                    document.getElementById('editProposalError').textContent = data.error || 'Failed to save';
                    document.getElementById('editProposalError').classList.remove('hidden');
                }
            } catch (err) {
                document.getElementById('editProposalError').textContent = 'Network error';
                document.getElementById('editProposalError').classList.remove('hidden');
            }
        });

        // ==================== DONATION VERIFICATION ====================
        async function loadPendingDonations() {
            const container = document.getElementById('donationsList');
            container.innerHTML = '<div class="text-center py-8 text-gray-500"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';
            
            try {
                const res = await fetch('/api/admin/donations/pending', {
                    headers: Auth.getApiHeaders()
                });
                const data = await res.json();
                
                if (data.success && data.donations && data.donations.length > 0) {
                    container.innerHTML = data.donations.map(d => `
                        <div class="bg-party-card border border-gray-700 p-4 rounded-xl">
                            <div class="flex justify-between items-start mb-3">
                                <div>
                                    <div class="font-bold text-lg">MVR ${d.amount}</div>
                                    <div class="text-sm text-gray-400">${d.name || 'Anonymous'} | ${d.phone || '—'} | NID: ${d.nid || '—'}</div>
                                    <div class="text-xs text-gray-500">${new Date(d.created_at).toLocaleString()}</div>
                                    ${d.remarks ? `<div class="text-xs text-gray-400 mt-1"><span class="font-semibold">Remarks:</span> ${d.remarks}</div>` : ''}
                                </div>
                                <span class="text-xs px-2 py-1 rounded bg-yellow-500/20 text-yellow-400">Pending</span>
                            </div>
                            ${d.slip_filename ? `
                                <div class="mb-3">
                                    <div class="text-sm text-gray-400 mb-2">Deposit Slip:</div>
                                    <a href="/uploads/${d.slip_filename}" target="_blank" class="block">
                                        <img src="/uploads/${d.slip_filename}" class="max-h-64 rounded border border-gray-700 hover:opacity-90 cursor-pointer" alt="Deposit Slip">
                                    </a>
                                    <div class="text-xs text-gray-500 mt-1">Click image to view full size</div>
                                </div>
                            ` : '<div class="mb-3 text-sm text-red-400"><i class="fas fa-exclamation-triangle mr-1"></i>No deposit slip uploaded</div>'}
                            <div class="flex gap-2">
                                <button onclick="verifyDonation(${d.id})" class="bg-green-500/20 text-green-400 px-3 py-1 rounded text-sm hover:bg-green-500/30">
                                    <i class="fas fa-check mr-1"></i>Verify & Approve
                                </button>
                                <button onclick="rejectDonation(${d.id})" class="bg-red-500/20 text-red-400 px-3 py-1 rounded text-sm hover:bg-red-500/30">
                                    <i class="fas fa-times mr-1"></i>Reject
                                </button>
                            </div>
                        </div>
                    `).join('');
                } else {
                    container.innerHTML = '<div class="text-center py-8 text-gray-500 bg-party-card rounded-xl border border-gray-700"><div class="text-3xl mb-3">💰</div><p>No pending donations.</p></div>';
                }
            } catch (err) {
                container.innerHTML = '<div class="text-center py-8 text-red-400">Error loading donations.</div>';
            }
        }

        async function verifyDonation(donationId) {
            try {
                const res = await fetch(`/api/admin/donations/${donationId}/verify`, {
                    method: 'POST',
                    headers: Auth.getApiHeaders()
                });
                const data = await res.json();
                
                if (data.success) {
                    alert('Donation verified! Amount added to Live Treasury.');
                    loadPendingDonations();
                    refreshData();
                } else {
                    alert(data.error || 'Failed to verify');
                }
            } catch (err) {
                alert('Network error');
            }
        }

        async function rejectDonation(donationId) {
            const reason = prompt('Reason for rejection:');
            if (reason === null) return;
            
            try {
                const res = await fetch(`/api/admin/donations/${donationId}/reject`, {
                    method: 'POST',
                    headers: Auth.getApiHeaders(),
                    body: JSON.stringify({ reason })
                });
                const data = await res.json();
                
                if (data.success) {
                    alert('Donation rejected.');
                    loadPendingDonations();
                }
            } catch (err) {
                alert('Network error');
            }
        }

        // ==================== TREASURY MANAGEMENT ====================
        async function loadTreasuryLedger() {
            const tbody = document.getElementById('adminLedgerBody');
            tbody.innerHTML = '<tr><td colspan="5" class="p-6 text-center text-gray-500"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>';
            try {
                const [ledgerRes, summaryRes] = await Promise.all([
                    fetch('/api/admin/treasury/ledger', { headers: Auth.getApiHeaders() }),
                    fetch('/api/treasury/summary')
                ]);
                const ledgerData = await ledgerRes.json();
                const summaryData = await summaryRes.json();

                if (summaryData.success) {
                    document.getElementById('adminBalance').textContent = 'MVR ' + summaryData.balance.toLocaleString();
                    document.getElementById('adminIncome').textContent = 'MVR ' + summaryData.total_income.toLocaleString();
                    document.getElementById('adminExpenses').textContent = 'MVR ' + summaryData.total_expenses.toLocaleString();
                }

                if (ledgerData.success && ledgerData.transactions && ledgerData.transactions.length > 0) {
                    tbody.innerHTML = ledgerData.transactions.map(tx => {
                        const date = new Date(tx.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
                        const isDonation = tx.type === 'donation';
                        const typeBadge = isDonation
                            ? '<span class="px-2 py-0.5 bg-green-400/10 text-green-400 rounded text-xs">Donation</span>'
                            : '<span class="px-2 py-0.5 bg-red-400/10 text-red-400 rounded text-xs">Expense</span>';
                        const amountClass = isDonation ? 'text-green-400' : 'text-red-400';
                        const amountPrefix = isDonation ? '+' : '-';
                        const source = tx.donor_nickname ? Utils.escapeHtml(tx.donor_nickname) : (tx.verified_by || tx.source_ref_type || '—');

                        return '<tr class="border-b border-gray-800 hover:bg-white/5 transition">' +
                            '<td class="p-3 text-gray-400 whitespace-nowrap">' + date + '</td>' +
                            '<td class="p-3">' + typeBadge + '</td>' +
                            '<td class="p-3">' + Utils.escapeHtml(tx.description) + '</td>' +
                            '<td class="p-3 text-right font-mono ' + amountClass + '">' + amountPrefix + tx.amount.toLocaleString() + '</td>' +
                            '<td class="p-3 text-gray-500 text-xs">' + source + '</td>' +
                            '</tr>';
                    }).join('');
                } else {
                    tbody.innerHTML = '<tr><td colspan="5" class="p-6 text-center text-gray-500">No transactions yet.</td></tr>';
                }
            } catch (e) {
                tbody.innerHTML = '<tr><td colspan="5" class="p-6 text-center text-red-400">Error loading ledger.</td></tr>';
            }
        }

        function showExpenditureForm() {
            document.getElementById('expenditureForm').classList.remove('hidden');
            document.getElementById('expAmount').value = '';
            document.getElementById('expDescription').value = '';
            document.getElementById('expCategory').value = 'operational';
        }

        function hideExpenditureForm() {
            document.getElementById('expenditureForm').classList.add('hidden');
        }

        async function createExpenditure() {
            const amount = parseFloat(document.getElementById('expAmount').value);
            const description = document.getElementById('expDescription').value.trim();
            const category = document.getElementById('expCategory').value;

            if (!amount || amount <= 0) return alert('Please enter a valid amount.');
            if (!description) return alert('Please enter a description.');

            try {
                const res = await fetch('/api/admin/treasury/expenditure', {
                    method: 'POST',
                    headers: Auth.getApiHeaders(),
                    body: JSON.stringify({ amount, description, category })
                });
                const data = await res.json();
                if (data.success) {
                    alert('Expenditure recorded! Balance: MVR ' + data.balance.toLocaleString());
                    hideExpenditureForm();
                    loadTreasuryLedger();
                    refreshData();
                } else {
                    alert(data.error || 'Failed to record expenditure.');
                }
            } catch (e) {
                alert('Network error');
            }
        }

        // ==================== EVENTS MANAGEMENT ====================
        async function loadAdminEvents() {
            const container = document.getElementById('eventsAdminList');
            container.innerHTML = '<div class="text-center py-8 text-gray-500"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

            try {
                const res = await fetch('/api/admin/events', {
                    headers: Auth.getApiHeaders()
                });
                const data = await res.json();

                if (data.success && data.events && data.events.length > 0) {
                    container.innerHTML = data.events.map(e => `
                        <div class="bg-party-card border border-gray-700 p-4 rounded-xl">
                            <div class="flex justify-between items-start mb-2">
                                <div>
                                    <div class="font-bold">${e.title}</div>
                                    <div class="text-sm text-gray-400 mt-1">${e.description || ''}</div>
                                    ${e.location ? `<div class="text-xs text-gray-500 mt-1"><i class="fas fa-map-marker-alt mr-1"></i>${e.location}</div>` : ''}
                                </div>
                                <span class="text-xs px-2 py-1 rounded ${new Date(e.event_date) > new Date() ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-400'}">
                                    ${new Date(e.event_date).toLocaleDateString()}
                                </span>
                            </div>
                            <div class="flex gap-2 mt-3">
                                <button onclick='editEvent(${JSON.stringify(e.id)}, ${JSON.stringify(e.title)}, ${JSON.stringify(e.description || "")}, ${JSON.stringify(e.event_date)}, ${JSON.stringify(e.location || "")})' class="text-blue-400 hover:text-blue-300 text-sm">
                                    <i class="fas fa-edit mr-1"></i>Edit
                                </button>
                                <button onclick="deleteEvent(${e.id})" class="text-red-400 hover:text-red-300 text-sm">
                                    <i class="fas fa-trash mr-1"></i>Delete
                                </button>
                            </div>
                        </div>
                    `).join('');
                } else {
                    container.innerHTML = '<div class="text-center py-8 text-gray-500 bg-party-card rounded-xl border border-gray-700"><div class="text-3xl mb-3">📅</div><p>No events scheduled.</p></div>';
                }
            } catch (err) {
                container.innerHTML = '<div class="text-center py-8 text-red-400">Error loading events.</div>';
            }
        }

        function showAddEventForm() {
            document.getElementById('eventFormTitle').textContent = 'New Event';
            document.getElementById('eventTitle').value = '';
            document.getElementById('eventDescription').value = '';
            document.getElementById('eventDate').value = '';
            document.getElementById('eventLocation').value = '';
            document.getElementById('editingEventId').value = '';
            document.getElementById('eventForm').classList.remove('hidden');
        }

        function hideEventForm() {
            document.getElementById('eventForm').classList.add('hidden');
        }

        function editEvent(id, title, description, eventDate, location) {
            document.getElementById('eventFormTitle').textContent = 'Edit Event';
            document.getElementById('eventTitle').value = title;
            document.getElementById('eventDescription').value = description;
            document.getElementById('eventDate').value = eventDate;
            document.getElementById('eventLocation').value = location;
            document.getElementById('editingEventId').value = id;
            document.getElementById('eventForm').classList.remove('hidden');
        }

        async function saveEvent() {
            const id = document.getElementById('editingEventId').value;
            const title = document.getElementById('eventTitle').value.trim();
            const description = document.getElementById('eventDescription').value.trim();
            const eventDate = document.getElementById('eventDate').value;
            const location = document.getElementById('eventLocation').value.trim();

            if (!title) { alert('Event title is required'); return; }
            if (!eventDate) { alert('Event date is required'); return; }

            const isEdit = !!id;
            const url = isEdit ? `/api/admin/events/${id}` : '/api/admin/events';
            const method = isEdit ? 'PUT' : 'POST';

            try {
                const res = await fetch(url, {
                    method,
                    headers: Auth.getApiHeaders(),
                    body: JSON.stringify({ title, description, event_date: eventDate, location })
                });
                const data = await res.json();

                if (data.success) {
                    hideEventForm();
                    loadAdminEvents();
                } else {
                    alert(data.error || 'Failed to save event');
                }
            } catch (err) {
                alert('Network error');
            }
        }

        async function deleteEvent(id) {
            if (!confirm('Delete this event?')) return;

            try {
                const res = await fetch(`/api/admin/events/${id}`, {
                    method: 'DELETE',
                    headers: Auth.getApiHeaders()
                });
                const data = await res.json();

                if (data.success) {
                    loadAdminEvents();
                } else {
                    alert(data.error || 'Failed to delete event');
                }
            } catch (err) {
                alert('Network error');
            }
        }

        // ==================== SYSTEM SETTINGS ====================
let systemSettings = {};

async function loadSystemSettings() {
    try {
        const res = await fetch('/api/system-settings', {
            headers: Auth.getApiHeaders()
        });
        const data = await res.json();
        if (data.success) {
            systemSettings = data.settings;
            renderSystemSettings();
        }
    } catch (err) {
        console.error('Error loading system settings:', err);
    }
}

function renderSystemSettings() {
    const panel = document.getElementById('systemSettingsPanel');
    
    const ms = (val) => {
        if (val < 60000) return val + ' ms';
        if (val < 3600000) return Math.round(val / 60000) + ' min';
        if (val < 86400000) return Math.round(val / 3600000) + ' hr';
        return Math.round(val / 86400000) + ' days';
    };
    
    const bytes = (val) => {
        if (val < 1024) return val + ' B';
        if (val < 1048576) return Math.round(val / 1024) + ' KB';
        return Math.round(val / 1048576) + ' MB';
    };

    panel.innerHTML = `
        <form id="systemSettingsForm" onsubmit="saveSystemSettings(event)">
            <!-- Rate Limits -->
            <div class="bg-party-card p-6 rounded-xl border border-gray-700">
                <h3 class="text-lg font-bold mb-4 text-party-accent"><i class="fas fa-clock mr-2"></i>Rate Limits & Timeouts</h3>
                <div class="grid md:grid-cols-2 gap-6">
                    <div>
                        <label class="block text-sm font-medium mb-2">Enrollment Rate Limit (ms)</label>
                        <input type="number" id="ss_enroll_rate_limit_ms" value="${systemSettings.enroll_rate_limit_ms}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Min time between enrollment searches per IP</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Enrollment Max Per Day</label>
                        <input type="number" id="ss_enroll_max_per_day" value="${systemSettings.enroll_max_per_day}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max enrollment searches per IP per day</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Vote Cooldown (ms)</label>
                        <input type="number" id="ss_vote_cooldown_ms" value="${systemSettings.vote_cooldown_ms}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Cooldown between law/article votes (default: 3600000 = 1hr)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Visitor Session Timeout (ms)</label>
                        <input type="number" id="ss_visitor_timeout_ms" value="${systemSettings.visitor_timeout_ms}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Active visitor session timeout (default: 300000 = 5min)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Proposal Voting Period (days)</label>
                        <input type="number" id="ss_proposal_voting_days" value="${systemSettings.proposal_voting_days}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">How long proposals stay open for voting</p>
                    </div>
                </div>
            </div>

            <!-- Content Limits -->
            <div class="bg-party-card p-6 rounded-xl border border-gray-700">
                <h3 class="text-lg font-bold mb-4 text-party-accent"><i class="fas fa-text-width mr-2"></i>Content Limits</h3>
                <div class="grid md:grid-cols-2 gap-6">
                    <div>
                        <label class="block text-sm font-medium mb-2">Wall Post Max Length</label>
                        <input type="number" id="ss_wall_post_max_length" value="${systemSettings.wall_post_max_length}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max characters for wall posts</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Proposal Title Max Length</label>
                        <input type="number" id="ss_proposal_title_max_length" value="${systemSettings.proposal_title_max_length}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max characters for proposal titles</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Proposal Description Max Length</label>
                        <input type="number" id="ss_proposal_description_max_length" value="${systemSettings.proposal_description_max_length}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max characters for proposal descriptions</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Nickname Max Length</label>
                        <input type="number" id="ss_nickname_max_length" value="${systemSettings.nickname_max_length}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max characters for user nicknames</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Wall Posts Limit</label>
                        <input type="number" id="ss_wall_posts_limit" value="${systemSettings.wall_posts_limit}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max wall posts returned per request</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Recent Votes Limit</label>
                        <input type="number" id="ss_recent_votes_limit" value="${systemSettings.recent_votes_limit}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max recent votes returned per request</p>
                    </div>
                </div>
            </div>

            <!-- Merit System -->
            <div class="bg-party-card p-6 rounded-xl border border-gray-700">
                <h3 class="text-lg font-bold mb-4 text-party-accent"><i class="fas fa-star mr-2"></i>Merit System</h3>
                <div class="grid md:grid-cols-4 gap-6">
                    <div>
                        <label class="block text-sm font-medium mb-2">Base Merit</label>
                        <input type="number" id="ss_signup_base_merit" value="${systemSettings.signup_base_merit}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Starting merit for new members</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Skills Merit</label>
                        <input type="number" id="ss_merit_skills" value="${systemSettings.merit_skills}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Merit bonus for skills</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Action Merit</label>
                        <input type="number" id="ss_merit_action" value="${systemSettings.merit_action}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Merit bonus for action</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Ideas Merit</label>
                        <input type="number" id="ss_merit_ideas" value="${systemSettings.merit_ideas}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Merit bonus for ideas</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Donation Merit</label>
                        <input type="number" id="ss_merit_donation" value="${systemSettings.merit_donation}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Merit bonus for donations</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Donation Bonus Per 100 MVR</label>
                        <input type="number" id="ss_donation_bonus_per_100" value="${systemSettings.donation_bonus_per_100}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Merit points per 100 MVR donated (flat formula only)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Random Bonus Max</label>
                        <input type="number" id="ss_signup_random_bonus_max" value="${systemSettings.signup_random_bonus_max}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max random merit bonus at signup (0 to value-1)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Donation Formula</label>
                        <select id="ss_donation_formula" class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                            <option value="log" ${systemSettings.donation_formula === 'log' ? 'selected' : ''}>Logarithmic (whitepaper)</option>
                            <option value="flat" ${systemSettings.donation_formula === 'flat' ? 'selected' : ''}>Flat (MVR/divisor * bonus)</option>
                        </select>
                        <p class="text-xs text-gray-500 mt-1">How donation merit is calculated</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Donation Divisor (MVR)</label>
                        <input type="number" id="ss_donation_divisor_mvr" value="${systemSettings.donation_divisor_mvr}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">MVR per unit for flat formula (default: 100)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Donation Log Multiplier</label>
                        <input type="number" id="ss_donation_log_multiplier" value="${systemSettings.donation_log_multiplier}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Multiplier for log formula (default: 35)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">USD/MVR Exchange Rate</label>
                        <input type="number" id="ss_donation_usd_mvr_rate" value="${systemSettings.donation_usd_mvr_rate}" step="0.01"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Exchange rate for log formula (default: 15.4)</p>
                    </div>
                </div>
            </div>

            <!-- Upload Limits -->
            <div class="bg-party-card p-6 rounded-xl border border-gray-700">
                <h3 class="text-lg font-bold mb-4 text-party-accent"><i class="fas fa-upload mr-2"></i>Upload Limits</h3>
                <div class="grid md:grid-cols-2 gap-6">
                    <div>
                        <label class="block text-sm font-medium mb-2">Max Upload Size (bytes)</label>
                        <input type="number" id="ss_max_upload_bytes" value="${systemSettings.max_upload_bytes}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max file upload size (default: 5242880 = 5MB)</p>
                    </div>
                </div>
            </div>

            <!-- Goals -->
            <div class="bg-party-card p-6 rounded-xl border border-gray-700">
                <h3 class="text-lg font-bold mb-4 text-party-accent"><i class="fas fa-bullseye mr-2"></i>Goals</h3>
                <div class="grid md:grid-cols-2 gap-6">
                    <div>
                        <label class="block text-sm font-medium mb-2">Target Members</label>
                        <input type="number" id="ss_target_members" value="${systemSettings.target_members}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Goal for membership (used for progress percentage)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Target Treasury (MVR)</label>
                        <input type="number" id="ss_target_treasury" value="${systemSettings.target_treasury}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Fundraising goal in MVR</p>
                    </div>
                </div>
            </div>

            <!-- Referral Points -->
            <div class="bg-party-card p-6 rounded-xl border border-gray-700">
                <h3 class="text-lg font-bold mb-4 text-party-accent"><i class="fas fa-users mr-2"></i>Referral Points</h3>
                <div class="grid md:grid-cols-4 gap-6">
                    <div>
                        <label class="block text-sm font-medium mb-2">Tier 1 Limit (invites)</label>
                        <input type="number" id="ss_referral_tier1_limit" value="${systemSettings.referral_tier1_limit}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max invites for tier 1 rewards</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Tier 2 Limit (invites)</label>
                        <input type="number" id="ss_referral_tier2_limit" value="${systemSettings.referral_tier2_limit}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max invites for tier 2 rewards</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Base Reward T1</label>
                        <input type="number" id="ss_referral_base_t1" value="${systemSettings.referral_base_t1}" step="0.5"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Base points per invite (tier 1)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Base Reward T2</label>
                        <input type="number" id="ss_referral_base_t2" value="${systemSettings.referral_base_t2}" step="0.5"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Base points per invite (tier 2)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Base Reward T3</label>
                        <input type="number" id="ss_referral_base_t3" value="${systemSettings.referral_base_t3}" step="0.5"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Base points per invite (tier 3+)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Engage Bonus T1</label>
                        <input type="number" id="ss_referral_engage_t1" value="${systemSettings.referral_engage_t1}" step="0.5"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Engage bonus per invite (tier 1)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Engage Bonus T2</label>
                        <input type="number" id="ss_referral_engage_t2" value="${systemSettings.referral_engage_t2}" step="0.5"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Engage bonus per invite (tier 2)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Engage Bonus T3</label>
                        <input type="number" id="ss_referral_engage_t3" value="${systemSettings.referral_engage_t3}" step="0.5"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Engage bonus per invite (tier 3+)</p>
                    </div>
                </div>
            </div>

            <!-- Endorsement Points -->
            <div class="bg-party-card p-6 rounded-xl border border-gray-700">
                <h3 class="text-lg font-bold mb-4 text-party-accent"><i class="fas fa-thumbs-up mr-2"></i>Endorsement Points</h3>
                <div class="grid md:grid-cols-4 gap-6">
                    <div>
                        <label class="block text-sm font-medium mb-2">Tier 1 Limit (endorsements)</label>
                        <input type="number" id="ss_endorsement_tier1_limit" value="${systemSettings.endorsement_tier1_limit}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max endorsements for tier 1 pts</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Tier 2 Limit (endorsements)</label>
                        <input type="number" id="ss_endorsement_tier2_limit" value="${systemSettings.endorsement_tier2_limit}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max endorsements for tier 2 pts</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Tier 3 Limit (endorsements)</label>
                        <input type="number" id="ss_endorsement_tier3_limit" value="${systemSettings.endorsement_tier3_limit}" 
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Max endorsements for tier 3 pts</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Tier 1 Points</label>
                        <input type="number" id="ss_endorsement_tier1_pts" value="${systemSettings.endorsement_tier1_pts}" step="0.5"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Points per endorsement (tier 1)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Tier 2 Points</label>
                        <input type="number" id="ss_endorsement_tier2_pts" value="${systemSettings.endorsement_tier2_pts}" step="0.5"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Points per endorsement (tier 2)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Tier 3 Points</label>
                        <input type="number" id="ss_endorsement_tier3_pts" value="${systemSettings.endorsement_tier3_pts}" step="0.5"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Points per endorsement (tier 3)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Tier 4 Points</label>
                        <input type="number" id="ss_endorsement_tier4_pts" value="${systemSettings.endorsement_tier4_pts}" step="0.1"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Points per endorsement (tier 4+)</p>
                    </div>
                </div>
            </div>

            <!-- Voting Thresholds & Windows -->
            <div class="bg-party-card p-6 rounded-xl border border-gray-700">
                <h3 class="text-lg font-bold mb-4 text-party-accent"><i class="fas fa-balance-scale mr-2"></i>Voting Thresholds & Windows</h3>
                <div class="grid md:grid-cols-3 gap-6">
                    <div>
                        <label class="block text-sm font-medium mb-2">Routine Approval Threshold</label>
                        <input type="number" id="ss_approval_threshold_routine" value="${systemSettings.approval_threshold_routine}" step="0.01"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Pass threshold for routine proposals (default: 0.50)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Policy Approval Threshold</label>
                        <input type="number" id="ss_approval_threshold_policy" value="${systemSettings.approval_threshold_policy}" step="0.01"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Pass threshold for policy proposals (default: 0.60)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Constitutional Approval Threshold</label>
                        <input type="number" id="ss_approval_threshold_constitutional" value="${systemSettings.approval_threshold_constitutional}" step="0.01"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Pass threshold for constitutional proposals (default: 0.80)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Primary Voting Window (days)</label>
                        <input type="number" id="ss_voting_window_primary_days" value="${systemSettings.voting_window_primary_days}"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Days for primary voting period (default: 7)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Extended Voting Window (days)</label>
                        <input type="number" id="ss_voting_window_extended_days" value="${systemSettings.voting_window_extended_days}"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Extra days if threshold not met (default: 3)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Primary Vote Weight</label>
                        <input type="number" id="ss_voting_weight_primary" value="${systemSettings.voting_weight_primary}" step="0.1"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Vote weight multiplier in primary window (default: 1.0)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Extended Vote Weight</label>
                        <input type="number" id="ss_voting_weight_extended" value="${systemSettings.voting_weight_extended}" step="0.1"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Vote weight multiplier in extended window (default: 0.5)</p>
                    </div>
                </div>
            </div>

            <!-- Proposal & Vote Merit -->
            <div class="bg-party-card p-6 rounded-xl border border-gray-700">
                <h3 class="text-lg font-bold mb-4 text-party-accent"><i class="fas fa-trophy mr-2"></i>Proposal & Vote Merit</h3>
                <div class="grid md:grid-cols-4 gap-6">
                    <div>
                        <label class="block text-sm font-medium mb-2">Proposal Cooldown (hours)</label>
                        <input type="number" id="ss_proposal_cooldown_hours" value="${systemSettings.proposal_cooldown_hours}"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Hours between proposals per user/IP (default: 8)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Vote Pass Merit</label>
                        <input type="number" id="ss_merit_vote_pass" value="${systemSettings.merit_vote_pass}" step="0.5"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Merit pts for voting on passing proposal (default: 2.5)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Vote Fail Merit</label>
                        <input type="number" id="ss_merit_vote_fail" value="${systemSettings.merit_vote_fail}" step="0.5"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Merit pts for voting on failing proposal (default: 1.0)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Proposal Author Merit</label>
                        <input type="number" id="ss_merit_proposal_author" value="${systemSettings.merit_proposal_author}"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Merit awarded to author of passing proposal (default: 200)</p>
                    </div>
                </div>
            </div>

            <!-- SMS OTP Settings -->
            <div class="bg-party-card p-6 rounded-xl border border-gray-700">
                <h3 class="text-lg font-bold mb-4 text-party-accent"><i class="fas fa-sms mr-2"></i>SMS OTP Verification</h3>
                <div class="grid md:grid-cols-2 gap-6">
                    <div>
                        <label class="block text-sm font-medium mb-2">Require OTP for Signup</label>
                        <select id="ss_sms_otp_required" class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                            <option value="0" ${systemSettings.sms_otp_required ? '' : 'selected'}>No (optional)</option>
                            <option value="1" ${systemSettings.sms_otp_required ? 'selected' : ''}>Yes (required)</option>
                        </select>
                        <p class="text-xs text-gray-500 mt-1">When OFF, signup works without phone verification</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">SMS Provider</label>
                        <select id="ss_sms_provider" class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                            <option value="" ${systemSettings.sms_provider ? '' : 'selected'}>None (dev mode)</option>
                            <option value="twilio" ${systemSettings.sms_provider === 'twilio' ? 'selected' : ''}>Twilio</option>
                            <option value="webhook" ${systemSettings.sms_provider === 'webhook' ? 'selected' : ''}>HTTP Webhook</option>
                        </select>
                        <p class="text-xs text-gray-500 mt-1">Twilio, custom webhook, or none (dev)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">OTP Code Length</label>
                        <input type="number" id="ss_sms_otp_length" value="${systemSettings.sms_otp_length != null ? systemSettings.sms_otp_length : 6}" min="4" max="8"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">Digits (default: 6)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">OTP Expiry (minutes)</label>
                        <input type="number" id="ss_sms_otp_expiry_minutes" value="${systemSettings.sms_otp_expiry_minutes != null ? systemSettings.sms_otp_expiry_minutes : 10}" min="1" max="60"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent">
                        <p class="text-xs text-gray-500 mt-1">How long before code expires (default: 10)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Twilio Phone Number</label>
                        <input type="text" id="ss_sms_twilio_phone_number" value="${systemSettings.sms_twilio_phone_number || ''}"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent"
                               placeholder="+9601234567">
                        <p class="text-xs text-gray-500 mt-1">Twilio sender number (or set TWILIO_PHONE_NUMBER env)</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-2">Webhook URL</label>
                        <input type="text" id="ss_sms_webhook_url" value="${systemSettings.sms_webhook_url || ''}"
                               class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent"
                               placeholder="https://your-gateway.com/sms">
                        <p class="text-xs text-gray-500 mt-1">POST {phone, message} for custom SMS gateways</p>
                    </div>
                </div>
                <p class="text-xs text-yellow-500 mt-3"><i class="fas fa-info-circle mr-1"></i> For Twilio: set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN as environment variables (or use admin settings above — insecure for secrets).</p>
            </div>

            <!-- AI Law Draft Prompt -->
            <div class="bg-party-card p-6 rounded-xl border border-gray-700">
                <h3 class="text-lg font-bold mb-4 text-party-accent"><i class="fas fa-robot mr-2"></i>AI Law Draft Prompt</h3>
                <div>
                    <label class="block text-sm font-medium mb-2">System Prompt</label>
                    <textarea id="ss_ai_law_draft_prompt" rows="12"
                              class="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-party-accent font-mono text-sm">${(systemSettings.ai_law_draft_prompt || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
                    <p class="text-xs text-gray-500 mt-1">This prompt is sent to the AI model when generating law drafts. Changes take effect immediately.</p>
                </div>
            </div>

            <div class="flex gap-4">
                <button type="submit" class="bg-party-accent text-party-dark px-6 py-2 rounded-lg font-bold hover:scale-105 transform transition">
                    <i class="fas fa-save mr-2"></i>Save All Settings
                </button>
                <button type="button" onclick="resetSystemSettings()" class="bg-gray-700 text-gray-300 px-6 py-2 rounded-lg font-bold hover:bg-gray-600 transition">
                    <i class="fas fa-undo mr-2"></i>Reset to Defaults
                </button>
            </div>
        </form>
    `;
}

async function saveSystemSettings(e) {
    e.preventDefault();
    
    const data = {
        enroll_rate_limit_ms: parseInt(document.getElementById('ss_enroll_rate_limit_ms').value),
        enroll_max_per_day: parseInt(document.getElementById('ss_enroll_max_per_day').value),
        vote_cooldown_ms: parseInt(document.getElementById('ss_vote_cooldown_ms').value),
        visitor_timeout_ms: parseInt(document.getElementById('ss_visitor_timeout_ms').value),
        proposal_voting_days: parseInt(document.getElementById('ss_proposal_voting_days').value),
        wall_post_max_length: parseInt(document.getElementById('ss_wall_post_max_length').value),
        proposal_title_max_length: parseInt(document.getElementById('ss_proposal_title_max_length').value),
        proposal_description_max_length: parseInt(document.getElementById('ss_proposal_description_max_length').value),
        nickname_max_length: parseInt(document.getElementById('ss_nickname_max_length').value),
        wall_posts_limit: parseInt(document.getElementById('ss_wall_posts_limit').value),
        recent_votes_limit: parseInt(document.getElementById('ss_recent_votes_limit').value),
        signup_base_merit: parseInt(document.getElementById('ss_signup_base_merit').value),
        merit_skills: parseInt(document.getElementById('ss_merit_skills').value),
        merit_action: parseInt(document.getElementById('ss_merit_action').value),
        merit_ideas: parseInt(document.getElementById('ss_merit_ideas').value),
        merit_donation: parseInt(document.getElementById('ss_merit_donation').value),
        donation_bonus_per_100: parseInt(document.getElementById('ss_donation_bonus_per_100').value),
        max_upload_bytes: parseInt(document.getElementById('ss_max_upload_bytes').value),
        target_members: parseInt(document.getElementById('ss_target_members').value),
        target_treasury: parseInt(document.getElementById('ss_target_treasury').value),
        signup_random_bonus_max: parseInt(document.getElementById('ss_signup_random_bonus_max').value),
        donation_divisor_mvr: parseInt(document.getElementById('ss_donation_divisor_mvr').value),
        donation_log_multiplier: parseInt(document.getElementById('ss_donation_log_multiplier').value),
        donation_usd_mvr_rate: parseFloat(document.getElementById('ss_donation_usd_mvr_rate').value),
        donation_formula: document.getElementById('ss_donation_formula').value,
        referral_tier1_limit: parseInt(document.getElementById('ss_referral_tier1_limit').value),
        referral_tier2_limit: parseInt(document.getElementById('ss_referral_tier2_limit').value),
        referral_base_t1: parseFloat(document.getElementById('ss_referral_base_t1').value),
        referral_base_t2: parseFloat(document.getElementById('ss_referral_base_t2').value),
        referral_base_t3: parseFloat(document.getElementById('ss_referral_base_t3').value),
        referral_engage_t1: parseFloat(document.getElementById('ss_referral_engage_t1').value),
        referral_engage_t2: parseFloat(document.getElementById('ss_referral_engage_t2').value),
        referral_engage_t3: parseFloat(document.getElementById('ss_referral_engage_t3').value),
        endorsement_tier1_limit: parseInt(document.getElementById('ss_endorsement_tier1_limit').value),
        endorsement_tier2_limit: parseInt(document.getElementById('ss_endorsement_tier2_limit').value),
        endorsement_tier3_limit: parseInt(document.getElementById('ss_endorsement_tier3_limit').value),
        endorsement_tier1_pts: parseFloat(document.getElementById('ss_endorsement_tier1_pts').value),
        endorsement_tier2_pts: parseFloat(document.getElementById('ss_endorsement_tier2_pts').value),
        endorsement_tier3_pts: parseFloat(document.getElementById('ss_endorsement_tier3_pts').value),
        endorsement_tier4_pts: parseFloat(document.getElementById('ss_endorsement_tier4_pts').value),
        approval_threshold_routine: parseFloat(document.getElementById('ss_approval_threshold_routine').value),
        approval_threshold_policy: parseFloat(document.getElementById('ss_approval_threshold_policy').value),
        approval_threshold_constitutional: parseFloat(document.getElementById('ss_approval_threshold_constitutional').value),
        voting_window_primary_days: parseInt(document.getElementById('ss_voting_window_primary_days').value),
        voting_window_extended_days: parseInt(document.getElementById('ss_voting_window_extended_days').value),
        voting_weight_primary: parseFloat(document.getElementById('ss_voting_weight_primary').value),
        voting_weight_extended: parseFloat(document.getElementById('ss_voting_weight_extended').value),
        proposal_cooldown_hours: parseInt(document.getElementById('ss_proposal_cooldown_hours').value),
        merit_vote_pass: parseFloat(document.getElementById('ss_merit_vote_pass').value),
        merit_vote_fail: parseFloat(document.getElementById('ss_merit_vote_fail').value),
        merit_proposal_author: parseInt(document.getElementById('ss_merit_proposal_author').value),
        sms_provider: document.getElementById('ss_sms_provider').value,
        sms_otp_required: parseInt(document.getElementById('ss_sms_otp_required').value),
        sms_otp_length: parseInt(document.getElementById('ss_sms_otp_length').value),
        sms_otp_expiry_minutes: parseInt(document.getElementById('ss_sms_otp_expiry_minutes').value),
        sms_twilio_phone_number: document.getElementById('ss_sms_twilio_phone_number').value,
        sms_webhook_url: document.getElementById('ss_sms_webhook_url').value,
        ai_law_draft_prompt: document.getElementById('ss_ai_law_draft_prompt').value
    };
    
    try {
        const res = await fetch('/api/system-settings', {
            method: 'POST',
            headers: Auth.getApiHeaders(),
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (result.success) {
            alert('Settings saved successfully!');
            systemSettings = result.settings;
            renderSystemSettings();
        } else {
            alert('Error: ' + result.error);
        }
    } catch (err) {
        alert('Failed to save settings');
    }
}

async function resetSystemSettings() {
    if (!confirm('Reset all settings to their default values?')) return;
    
    const defaults = {
        enroll_rate_limit_ms: 60000,
        enroll_max_per_day: 50,
        vote_cooldown_ms: 3600000,
        visitor_timeout_ms: 300000,
        proposal_voting_days: 7,
        wall_post_max_length: 500,
        proposal_title_max_length: 200,
        proposal_description_max_length: 8000,
        nickname_max_length: 50,
        wall_posts_limit: 100,
        recent_votes_limit: 50,
        signup_base_merit: 50,
        merit_skills: 250,
        merit_action: 200,
        merit_ideas: 150,
        merit_donation: 100,
        donation_bonus_per_100: 5,
        max_upload_bytes: 5242880,
        target_members: 13000,
        target_treasury: 13000,
        signup_random_bonus_max: 50,
        donation_divisor_mvr: 100,
        donation_log_multiplier: 35,
        donation_usd_mvr_rate: 15.4,
        donation_formula: 'log',
        referral_tier1_limit: 5,
        referral_tier2_limit: 20,
        referral_base_t1: 2,
        referral_base_t2: 1,
        referral_base_t3: 0.5,
        referral_engage_t1: 8,
        referral_engage_t2: 4,
        referral_engage_t3: 0.5,
        endorsement_tier1_limit: 10,
        endorsement_tier2_limit: 50,
        endorsement_tier3_limit: 200,
        endorsement_tier1_pts: 2.0,
        endorsement_tier2_pts: 1.0,
        endorsement_tier3_pts: 0.5,
        endorsement_tier4_pts: 0.1,
        sms_provider: '',
        sms_otp_required: 0,
        sms_otp_length: 6,
        sms_otp_expiry_minutes: 10,
        sms_twilio_phone_number: '',
        sms_webhook_url: '',
        ai_law_draft_prompt: `You are a legal drafting assistant for the Maldives. Given a seed idea, produce a well-structured draft using proper legal formatting.\n\nIMPORTANT — First, determine the appropriate scope:\n- "law" - Broad, multi-section legislation that establishes a new regulatory framework\n- "regulation" - Specific rules under an existing law, narrower in scope\n- "clause" - A single provision or amendment to an existing law\n\nThe FIRST LINE of your response MUST be: **Draft Type:** law (or regulation, or clause)\n\nThen structure your response with these sections (each required section MUST start with ## ):\n\n## Executive Summary\nA concise, plain-language summary of the proposal in 3-5 bullet points, written for citizens who won't read the full legal text. Summarize: (1) What problem this solves, (2) What the law proposes to do, (3) Who is affected, (4) Key obligations/rights created, (5) How it will be enforced. Use simple language — no legal jargon.\n\n## Title\nA clear, concise title for the proposal.\n\n## Preamble\nA brief statement of purpose and rationale (2-3 sentences).\n\n## Definitions\nKey terms defined precisely (if applicable).\n\n## Provisions\nNumbered sections. Each section should have:\n- A clear heading\n- Specific requirements, prohibitions, or permissions\n- Enforcement mechanisms where appropriate\n\n## Penalties / Enforcement\nConsequences for non-compliance (if applicable).\n\n## Commencement\nWhen the law takes effect.\n\nDraft in a formal legal style. Use "shall" for obligations, "may" for permissions. Be specific and enforceable. Keep the draft proportional to the scope — a clause should be a few paragraphs, a law can be several pages. Do NOT include placeholder text or markdown formatting instructions in the output.`
    };
    
    try {
        const res = await fetch('/api/system-settings', {
            method: 'POST',
            headers: Auth.getApiHeaders(),
            body: JSON.stringify(defaults)
        });
        const result = await res.json();
        if (result.success) {
            alert('Settings reset to defaults!');
            systemSettings = result.settings;
            renderSystemSettings();
        }
    } catch (err) {
        alert('Failed to reset settings');
    }
}

// ── Wall Moderation ──
let allPostsOffset = 0;
const ALL_POSTS_LIMIT = 50;

async function loadAllPosts() {
    allPostsOffset = 0;
    const container = document.getElementById('allPostsList');
    const loadMoreBtn = document.getElementById('loadMoreContainer');
    container.innerHTML = '<div class="text-center py-8 text-gray-500">Loading all posts...</div>';
    loadMoreBtn.classList.add('hidden');
    try {
        const res = await fetch(`/api/admin/wall/all?limit=${ALL_POSTS_LIMIT}&offset=0`, {
            headers: Auth.getApiHeaders()
        });
        const data = await res.json();
        if (data.success) {
            renderAllPosts(data.posts, container);
            allPostsOffset = data.posts.length;
            document.getElementById('postCount').textContent = `${data.total} total posts`;
            if (allPostsOffset < data.total) {
                loadMoreBtn.classList.remove('hidden');
            }
        } else {
            container.innerHTML = '<div class="text-center py-8 text-gray-500">No posts found.</div>';
        }
    } catch (err) {
        container.innerHTML = '<div class="text-center py-8 text-red-400">Error loading posts.</div>';
    }
}

async function loadMorePosts() {
    const container = document.getElementById('allPostsList');
    const loadMoreBtn = document.getElementById('loadMoreContainer');
    try {
        const res = await fetch(`/api/admin/wall/all?limit=${ALL_POSTS_LIMIT}&offset=${allPostsOffset}`, {
            headers: Auth.getApiHeaders()
        });
        const data = await res.json();
        if (data.success && data.posts.length > 0) {
            renderAllPosts(data.posts, container, true);
            allPostsOffset += data.posts.length;
            if (allPostsOffset >= data.total) {
                loadMoreBtn.classList.add('hidden');
            }
        } else {
            loadMoreBtn.classList.add('hidden');
        }
    } catch (err) {
        alert('Error loading more posts');
    }
}

function renderAllPosts(posts, container, append = false) {
    const html = posts.map(p => {
        const statusBadges = [];
        if (p.is_hidden) statusBadges.push('<span class="text-xs bg-red-600/30 text-red-400 px-2 py-0.5 rounded">Hidden</span>');
        if (p.is_flagged) statusBadges.push(`<span class="text-xs bg-yellow-600/30 text-yellow-400 px-2 py-0.5 rounded"><i class="fas fa-flag mr-1"></i>Flagged</span>`);
        if (!p.is_flagged && !p.is_hidden) statusBadges.push('<span class="text-xs bg-green-600/30 text-green-400 px-2 py-0.5 rounded">Published</span>');

        const actions = [];
        if (!p.is_hidden) {
            actions.push(`<button onclick="hideWallPost(${p.id})" class="bg-red-600/80 text-white px-3 py-1.5 rounded hover:bg-red-700">Unpublish</button>`);
        } else {
            actions.push(`<button onclick="unhideWallPost(${p.id})" class="bg-green-600/80 text-white px-3 py-1.5 rounded hover:bg-green-700">Publish</button>`);
        }
        if (p.is_flagged) {
            actions.push(`<button onclick="approveWallPost(${p.id})" class="bg-blue-600/80 text-white px-3 py-1.5 rounded hover:bg-blue-700">Dismiss Flag</button>`);
        }
        actions.push(`<button onclick="deleteWallPost(${p.id})" class="bg-gray-600/80 text-white px-3 py-1.5 rounded hover:bg-gray-700">Delete</button>`);

        return `
            <div class="bg-party-card rounded-xl p-5 border border-gray-700">
                <div class="flex items-start justify-between mb-2">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-bold text-party-accent">${Utils.escapeHtml(p.display_name || p.nickname)}</span>
                        ${p.user_id ? '<span class="text-xs text-green-400">Member</span>' : '<span class="text-xs text-gray-500">Guest</span>'}
                        ${statusBadges.join(' ')}
                        ${p.flag_count > 0 ? `<span class="text-xs text-yellow-500"><i class="fas fa-flag mr-1"></i>${p.flag_count} flags</span>` : ''}
                    </div>
                    <span class="text-gray-600 text-xs whitespace-nowrap ml-2">${p.timestamp ? new Date(p.timestamp).toLocaleString() : ''}</span>
                </div>
                <p class="text-gray-300 text-sm mb-3 whitespace-pre-wrap">${Utils.escapeHtml(p.message || '')}</p>
                ${p.latest_flag_reason ? `<p class="text-yellow-400/70 text-xs mb-3"><i class="fas fa-exclamation-triangle mr-1"></i>${Utils.escapeHtml(p.latest_flag_reason)}</p>` : ''}
                <div class="flex gap-2 text-xs flex-wrap">
                    ${actions.join(' ')}
                </div>
            </div>
        `;
    }).join('');

    if (append) {
        container.insertAdjacentHTML('beforeend', html);
    } else {
        container.innerHTML = html;
    }
}

async function hideWallPost(id) {
    if (!confirm('Unpublish this post? It will no longer be visible on the wall.')) return;
    try {
        const res = await fetch(`/api/admin/wall/${id}/hide`, {
            method: 'POST',
            headers: Auth.getApiHeaders()
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message);
            loadAllPosts();
        } else {
            alert(data.error);
        }
    } catch (err) { alert('Error'); }
}

async function unhideWallPost(id) {
    if (!confirm('Publish this post? It will become visible on the wall.')) return;
    try {
        const res = await fetch(`/api/admin/wall/${id}/unhide`, {
            method: 'POST',
            headers: Auth.getApiHeaders()
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message);
            loadAllPosts();
        } else {
            alert(data.error);
        }
    } catch (err) { alert('Error'); }
}

async function approveWallPost(id) {
    if (!confirm('Dismiss flag on this post? It will remain visible on the wall.')) return;
    try {
        const res = await fetch(`/api/admin/wall/${id}/approve`, {
            method: 'POST',
            headers: Auth.getApiHeaders()
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message);
            loadAllPosts();
        } else {
            alert(data.error);
        }
    } catch (err) { alert('Error'); }
}

async function deleteWallPost(id) {
    if (!confirm('PERMANENTLY delete this post and all its replies? This cannot be undone.')) return;
    try {
        const res = await fetch(`/api/admin/wall/${id}/delete`, {
            method: 'POST',
            headers: Auth.getApiHeaders()
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message);
            loadAllPosts();
        } else {
            alert(data.error);
        }
    } catch (err) { alert('Error'); }
}

// Load data on page load
        setTimeout(() => {
            loadProposalsAdmin();
            loadPendingDonations();
            loadTreasuryLedger();
            loadAllPosts();
            loadAdminEvents();
        }, 1000);
