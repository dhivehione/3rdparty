// Shared navigation component for 3d Party website
// Include this script in all HTML pages

function getPageName() {
    const path = window.location.pathname;
    if (path === '/' || path === '/index.html') return 'home';
    if (path.includes('intro')) return 'intro';
    if (path.includes('how')) return 'how-it-works';
    if (path.includes('whitepaper')) return 'whitepaper';
    if (path.includes('generate-law')) return 'generate-law';
    if (path.includes('enroll')) return 'enroll';
    if (path.includes('laws') && !path.includes('law-stats')) return 'laws';
    if (path.includes('law-stats')) return 'law-stats';
    if (path.includes('legislature')) return 'legislature';
    if (path.includes('proposals')) return 'proposals';
    if (path.includes('wall')) return 'wall';
    if (path.includes('join')) return 'join';
    if (path.includes('join-success')) return 'join-success';
    if (path.includes('donate')) return 'donate';
    if (path.includes('events')) return 'events';
    if (path.includes('profile')) return 'profile';
    if (path.includes('leadership')) return 'leadership';
    if (path.includes('faq')) return 'faq';
    if (path.includes('policies')) return 'policies';
    if (path.includes('admin')) return 'admin';
    if (path.includes('treasury')) return 'treasury';
    return '';
}

function isLoggedIn() {
    return window.Auth && typeof window.Auth.isLoggedIn === 'function' ? window.Auth.isLoggedIn() : !!localStorage.getItem('authToken');
}

function getDisplayName() {
    if (!window.Auth || typeof window.Auth.getUser !== 'function') return 'Member';
    const user = window.Auth.getUser();
    if (user) {
        return user.name || user.username || 'Member';
    }
    return 'Member';
}

function createNavigation() {
    const currentPage = getPageName();
    const loggedIn = isLoggedIn();
    const displayName = getDisplayName();
    
    const nav = document.createElement('nav');
    nav.className = 'border-b border-gray-800 bg-party-dark/95 sticky top-0 z-50 backdrop-blur';
    nav.innerHTML = `
        <div class="max-w-6xl mx-auto px-4 py-3 flex justify-between items-center">
            <div class="flex items-center space-x-2">
                <a href="/" class="flex items-center space-x-2">
                    <span class="text-2xl font-bold text-party-accent">3d</span>
                    <span class="text-sm text-gray-400">Party</span>
                </a>
            </div>
            <div class="flex items-center space-x-4 text-sm">
                <a href="/" class="hover:text-party-accent transition ${currentPage === 'home' ? 'text-party-accent font-bold' : 'text-gray-300'}">Home</a>
                <a href="/intro" class="hover:text-party-accent transition ${currentPage === 'intro' ? 'text-party-accent font-bold' : 'text-gray-300'}">Our Story</a>
                <a href="/how-it-works" class="hover:text-party-accent transition ${currentPage === 'how-it-works' ? 'text-party-accent font-bold' : 'text-gray-300'}">How</a>
                <a href="/whitepaper" class="hover:text-party-accent transition ${currentPage === 'whitepaper' ? 'text-party-accent font-bold' : 'text-gray-300'}">Whitepaper</a>
                <a href="/laws" class="hover:text-party-accent transition ${currentPage === 'laws' ? 'text-party-accent font-bold' : 'text-gray-300'}">Laws</a>
                <a href="/proposals" class="hover:text-party-accent transition ${currentPage === 'proposals' ? 'text-party-accent font-bold' : 'text-gray-300'}">Proposals</a>
                <a href="/enroll" class="hover:text-party-accent transition ${currentPage === 'enroll' ? 'text-party-accent font-bold' : 'text-gray-300'}">Enroll</a>
                <a href="/wall" class="hover:text-party-accent transition ${currentPage === 'wall' ? 'text-party-accent font-bold' : 'text-gray-300'}">Wall</a>
                <a href="/events" class="hover:text-party-accent transition ${currentPage === 'events' ? 'text-party-accent font-bold' : 'text-gray-300'}">Events</a>
                <a href="/faq" class="hover:text-party-accent transition ${currentPage === 'faq' ? 'text-party-accent font-bold' : 'text-gray-300'}">FAQ</a>
                <a href="/donate" class="hover:text-party-accent transition ${currentPage === 'donate' ? 'text-party-accent font-bold' : 'text-gray-300'}">Donate</a>
                <a href="/treasury" class="hover:text-party-accent transition ${currentPage === 'treasury' ? 'text-party-accent font-bold' : 'text-gray-300'}">Treasury</a>
                ${loggedIn ? `
                <div class="relative ml-2" id="user-menu-container">
                    <button id="user-menu-btn" class="flex items-center space-x-1 px-3 py-1 border border-party-accent text-party-accent rounded font-bold hover:bg-party-accent/10 transition">
                        <i class="fas fa-user-circle mr-1"></i>
                        <span id="user-menu-name">${displayName}</span>
                        <i class="fas fa-chevron-down ml-1 text-xs"></i>
                    </button>
                    <div id="user-menu-dropdown" class="hidden absolute right-0 mt-2 w-48 bg-party-card border border-gray-700 rounded-lg shadow-xl z-50">
                        <a href="/profile" class="block px-4 py-3 text-gray-300 hover:bg-party-dark hover:text-party-accent transition rounded-t-lg">
                            <i class="fas fa-user mr-2"></i>Profile
                        </a>
                        <button onclick="handleLogout()" class="w-full text-left px-4 py-3 text-red-400 hover:bg-party-dark hover:text-red-300 transition rounded-b-lg">
                            <i class="fas fa-sign-out-alt mr-2"></i>Logout
                        </button>
                    </div>
                </div>
                ` : `
                <button id="login-btn" onclick="openQuickLogin()" class="px-3 py-1 border border-party-accent text-party-accent rounded font-bold hover:bg-party-accent/10 transition ml-2">
                    <i class="fas fa-sign-in-alt mr-1"></i>Login
                </button>
                `}
                <span id="active-visitors" class="text-gray-400 text-xs ml-2">
                    <i class="fas fa-users mr-1"></i>—
                </span>
                <span id="new-joins-notification" class="text-green-400 text-xs ml-2 hidden">
                    <i class="fas fa-user-plus mr-1"></i><span></span>
                </span>
            </div>
        </div>
    `;
    
    return nav;
}

function openQuickLogin() {
    const modal = document.getElementById('quick-login-modal');
    if (modal) {
        modal.classList.remove('hidden');
        document.getElementById('quick-login-nid')?.focus();
    }
}

function closeQuickLogin() {
    const modal = document.getElementById('quick-login-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

async function quickLoginCheckNid() {
    const nid = document.getElementById('quick-login-nid').value.trim();
    if (!nid) { alert('Please enter your NID'); return; }
    
    try {
        const res = await fetch('/api/check-registration', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nid })
        });
        const data = await res.json();
        
        if (data.registered) {
            document.getElementById('quick-login-nid-section').classList.add('hidden');
            document.getElementById('quick-login-phone-section').classList.remove('hidden');
            document.getElementById('quick-login-phone').focus();
        } else {
            alert('You are not registered yet. Please join first!');
            window.location.href = '/join';
        }
    } catch (e) { alert('Error checking registration. Please try again.'); }
}

async function quickLoginWithPhone() {
    const phone = document.getElementById('quick-login-phone').value.trim();
    const nid = document.getElementById('quick-login-nid').value.trim();
    
    if (!phone) { alert('Please enter your phone number'); return; }
    
    try {
        const res = await fetch('/api/user/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, nid })
        });
        
        const data = await res.json();
        if (data.success) {
            Auth.setToken(data.token);
            Auth.setPhone(data.user.phone);
            Auth.setUser(data.user);
            Auth.markLogin();
            closeQuickLogin();
            window.location.reload();
        } else {
            alert(data.error || 'Login failed');
        }
    } catch (e) { alert('Login error. Please try again.'); }
}

function createQuickLoginModal() {
    const modal = document.createElement('div');
    modal.id = 'quick-login-modal';
    modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-[100] hidden';
    modal.onclick = (e) => { if (e.target === modal) closeQuickLogin(); };
    modal.innerHTML = `
        <div class="bg-party-card rounded-xl p-8 border border-gray-700 max-w-md w-full mx-4">
            <div class="flex justify-between items-center mb-6">
                <h2 class="text-xl font-bold text-party-accent">Sign In</h2>
                <button onclick="closeQuickLogin()" class="text-gray-400 hover:text-white"><i class="fas fa-times"></i></button>
            </div>
            
            <div id="quick-login-nid-section" class="space-y-4">
                <div>
                    <label class="block text-gray-400 text-sm mb-1">Enter your NID</label>
                    <input type="text" id="quick-login-nid" placeholder="A123456" 
                           class="w-full bg-party-dark border border-gray-600 rounded-lg px-4 py-3 text-white"
                           onkeypress="if(event.key==='Enter')quickLoginCheckNid()">
                </div>
                <button onclick="quickLoginCheckNid()" class="w-full bg-party-accent text-black font-bold py-3 rounded-lg hover:bg-yellow-400">
                    Continue
                </button>
            </div>
            
            <div id="quick-login-phone-section" class="hidden space-y-4 mt-4">
                <div class="p-4 bg-green-900/30 border border-green-600 rounded-lg">
                    <p class="text-green-400">You are registered!</p>
                </div>
                <div>
                    <label class="block text-gray-400 text-sm mb-1">Phone Number</label>
                    <input type="tel" id="quick-login-phone" placeholder="7-digit number" 
                           class="w-full bg-party-dark border border-gray-600 rounded-lg px-4 py-3 text-white"
                           onkeypress="if(event.key==='Enter')quickLoginWithPhone()">
                </div>
                <button onclick="quickLoginWithPhone()" class="w-full bg-party-accent text-black font-bold py-3 rounded-lg hover:bg-yellow-400">
                    Sign In
                </button>
                <button onclick="document.getElementById('quick-login-nid-section').classList.remove('hidden');document.getElementById('quick-login-phone-section').classList.add('hidden');" class="w-full text-gray-400 text-sm hover:text-party-accent">
                    ← Back
                </button>
            </div>
            
            <p class="text-center text-gray-500 text-sm mt-6">
                Don't have an account? <a href="/join" class="text-party-accent hover:underline">Join here</a>
            </p>
        </div>
    `;
    return modal;
}

function createFooter() {
    const footer = document.createElement('footer');
    footer.className = 'border-t border-gray-800 py-8 px-4 mt-12';
    footer.innerHTML = `
        <div class="max-w-6xl mx-auto">
            <div class="flex flex-col md:flex-row justify-between items-center gap-4">
                <div class="text-center md:text-left">
                    <div class="text-xl font-bold text-party-accent mb-2">3d Party</div>
                    <p class="text-gray-500 text-sm">The actual third option. Still not insurance.</p>
                </div>
                <div class="flex gap-6 text-sm flex-wrap">
                    <a href="/intro" class="text-gray-400 hover:text-party-accent">Our Story</a>
                    <a href="/how-it-works" class="text-gray-400 hover:text-party-accent">How</a>
                    <a href="/whitepaper" class="text-gray-400 hover:text-party-accent">Whitepaper</a>
                    <a href="/laws" class="text-gray-400 hover:text-party-accent">Laws</a>
                    <a href="/proposals" class="text-gray-400 hover:text-party-accent">Proposals</a>
                    <a href="/enroll" class="text-gray-400 hover:text-party-accent">Enroll</a>
                    <a href="/wall" class="text-gray-400 hover:text-party-accent">Wall</a>
                    <a href="/events" class="text-gray-400 hover:text-party-accent">Events</a>
                    <a href="/faq" class="text-gray-400 hover:text-party-accent">FAQ</a>
                    <a href="/join" class="text-gray-400 hover:text-party-accent">Join</a>
                    <a href="/donate" class="text-gray-400 hover:text-party-accent">Donate</a>
                    <a href="/treasury" class="text-gray-400 hover:text-party-accent">Treasury</a>
                </div>
                <div class="text-center mt-4 max-w-xl mx-auto">
                    <p class="text-gray-600 text-sm italic">"No party bosses. No backroom deals. No lifetime politicians. Just citizens serving citizens."</p>
                </div>
                <div class="flex items-center gap-4">
                    <a href="https://github.com/3dparty" target="_blank" rel="noopener" class="text-gray-400 hover:text-party-accent">
                        <i class="fab fa-github text-xl"></i>
                        <span class="ml-2">GitHub</span>
                    </a>
                    <span class="text-gray-600 text-sm">Open Source</span>
                </div>
            </div>
            <div class="text-center mt-6 text-gray-600 text-xs">
                © 2026 3d Party Maldives. Built with ❤️ for digital democracy.
            </div>
        </div>
    `;
    return footer;
}

function injectNavigation() {
    const existingNav = document.querySelector('nav');
    const newNav = createNavigation();
    
    if (existingNav) {
        existingNav.parentNode.replaceChild(newNav, existingNav);
    } else {
        document.body.insertBefore(newNav, document.body.firstChild);
    }
    
    const modal = createQuickLoginModal();
    document.body.appendChild(modal);
    
    const existingFooter = document.querySelector('footer');
    const newFooter = createFooter();
    
    if (existingFooter) {
        existingFooter.parentNode.replaceChild(newFooter, existingFooter);
    } else {
        document.body.appendChild(newFooter);
    }
    
    setupUserMenu();
}

function setupUserMenu() {
    const btn = document.getElementById('user-menu-btn');
    const dropdown = document.getElementById('user-menu-dropdown');
    const container = document.getElementById('user-menu-container');
    
    if (btn && dropdown) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('hidden');
        });
        
        document.addEventListener('click', (e) => {
            if (container && !container.contains(e.target)) {
                dropdown.classList.add('hidden');
            }
        });
    }
}

function handleLogout() {
    if (window.Auth) {
        Auth.logout('/api/user/logout');
    }
    window.location.href = '/';
}

function refreshNavAuth() {
    const nav = document.querySelector('nav');
    if (!nav) return;
    
    const loggedIn = isLoggedIn();
    const loginBtn = document.getElementById('login-btn');
    const userMenu = document.getElementById('user-menu-container');
    
    if (loggedIn && !userMenu) {
        nav.innerHTML = nav.innerHTML.replace(
            /<button id="login-btn"[^>]*>[\s\S]*?<\/button>/,
            `<div class="relative ml-2" id="user-menu-container">
                <button id="user-menu-btn" class="flex items-center space-x-1 px-3 py-1 border border-party-accent text-party-accent rounded font-bold hover:bg-party-accent/10 transition">
                    <i class="fas fa-user-circle mr-1"></i>
                    <span id="user-menu-name">${getDisplayName()}</span>
                    <i class="fas fa-chevron-down ml-1 text-xs"></i>
                </button>
                <div id="user-menu-dropdown" class="hidden absolute right-0 mt-2 w-48 bg-party-card border border-gray-700 rounded-lg shadow-xl z-50">
                    <a href="/profile" class="block px-4 py-3 text-gray-300 hover:bg-party-dark hover:text-party-accent transition rounded-t-lg">
                        <i class="fas fa-user mr-2"></i>Profile
                    </a>
                    <button onclick="handleLogout()" class="w-full text-left px-4 py-3 text-red-400 hover:bg-party-dark hover:text-red-300 transition rounded-b-lg">
                        <i class="fas fa-sign-out-alt mr-2"></i>Logout
                    </button>
                </div>
            </div>`
        );
        setupUserMenu();
    } else if (!loggedIn && !loginBtn) {
        nav.innerHTML = nav.innerHTML.replace(
            /<div class="relative ml-2" id="user-menu-container">[\s\S]*?<\/div>/,
            `<button id="login-btn" onclick="openQuickLogin()" class="px-3 py-1 border border-party-accent text-party-accent rounded font-bold hover:bg-party-accent/10 transition ml-2">
                <i class="fas fa-sign-in-alt mr-1"></i>Login
            </button>`
        );
    } else if (loggedIn && userMenu) {
        const nameEl = document.getElementById('user-menu-name');
        if (nameEl) nameEl.textContent = getDisplayName();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectNavigation);
} else {
    injectNavigation();
}

window.addEventListener('storage', (e) => {
    if (e.key === '_3p_auth' || e.key === 'authToken') refreshNavAuth();
});

(function() {
    let sessionId = sessionStorage.getItem('visitor_session');
    if (!sessionId) {
        sessionId = 'v_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        sessionStorage.setItem('visitor_session', sessionId);
    }
    
    function updateActiveCount() {
        fetch('/api/analytics/active')
            .then(r => r.json())
            .then(d => {
                if (d.success) {
                    const el = document.getElementById('active-visitors');
                    if (el) el.innerHTML = '<i class="fas fa-users mr-1"></i>' + d.active;
                }
            })
            .catch(() => {});
    }
    
    function heartbeat() {
        fetch('/api/analytics/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId })
        }).then(r => r.json()).then(d => {
            if (d.active_count !== undefined) {
                const el = document.getElementById('active-visitors');
                if (el) el.innerHTML = '<i class="fas fa-users mr-1"></i>' + d.active_count;
            }
        }).catch(() => {});
    }
    
    function checkNewJoins() {
        const lastLogin = localStorage.getItem('3dparty_last_login');
        if (!lastLogin) return;
        
        fetch(`/api/stats/new-joins?last_login=${encodeURIComponent(lastLogin)}`)
            .then(r => r.json())
            .then(d => {
                if (d.success && d.new_joins > 0) {
                    const el = document.getElementById('new-joins-notification');
                    const span = el?.querySelector('span');
                    if (el && span) {
                        span.textContent = `${d.new_joins} joined since your last visit`;
                        el.classList.remove('hidden');
                    }
                }
            })
            .catch(() => {});
    }
    
    heartbeat();
    setInterval(heartbeat, 30000);
    setTimeout(updateActiveCount, 2000);
    setTimeout(checkNewJoins, 3000);
})();
