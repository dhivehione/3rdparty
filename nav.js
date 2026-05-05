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

function createNavigation() {
    const currentPage = getPageName();
    
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
                <a href="/intro" class="hover:text-party-accent transition ${currentPage === 'intro' ? 'text-party-accent font-bold' : 'text-gray-300'}">Intro</a>
                <a href="/how-it-works" class="hover:text-party-accent transition ${currentPage === 'how-it-works' ? 'text-party-accent font-bold' : 'text-gray-300'}">How</a>
                <a href="/whitepaper" class="hover:text-party-accent transition ${currentPage === 'whitepaper' ? 'text-party-accent font-bold' : 'text-gray-300'}">Whitepaper</a>
                <a href="/laws" class="hover:text-party-accent transition ${currentPage === 'laws' ? 'text-party-accent font-bold' : 'text-gray-300'}">Laws</a>
                <a href="/generate-law" class="hover:text-party-accent transition ${currentPage === 'generate-law' ? 'text-party-accent font-bold' : 'text-gray-300'}">Craft a Law</a>
                <a href="/proposals" class="hover:text-party-accent transition ${currentPage === 'proposals' ? 'text-party-accent font-bold' : 'text-gray-300'}">Proposals</a>
                <a href="/enroll" class="hover:text-party-accent transition ${currentPage === 'enroll' ? 'text-party-accent font-bold' : 'text-gray-300'}">Enroll</a>
                <a href="/wall" class="hover:text-party-accent transition ${currentPage === 'wall' ? 'text-party-accent font-bold' : 'text-gray-300'}">Wall</a>
                <a href="/events" class="hover:text-party-accent transition ${currentPage === 'events' ? 'text-party-accent font-bold' : 'text-gray-300'}">Events</a>
                <a href="/faq" class="hover:text-party-accent transition ${currentPage === 'faq' ? 'text-party-accent font-bold' : 'text-gray-300'}">FAQ</a>
                <a href="/join" class="px-3 py-1 bg-party-accent text-party-dark rounded font-bold hover:bg-party-accent/80 transition ${currentPage === 'join' ? 'ring-2 ring-party-accent/50' : ''}">Join</a>
                <a href="/donate" class="hover:text-party-accent transition ${currentPage === 'donate' ? 'text-party-accent font-bold' : 'text-gray-300'}">Donate</a>
                <a href="/treasury" class="hover:text-party-accent transition ${currentPage === 'treasury' ? 'text-party-accent font-bold' : 'text-gray-300'}">Treasury</a>
                <button id="quick-login-btn" onclick="openQuickLogin()" class="px-3 py-1 border border-party-accent text-party-accent rounded font-bold hover:bg-party-accent/10 transition ${currentPage === 'profile' ? 'ring-2 ring-party-accent/50' : ''}"><i class="fas fa-sign-in-alt mr-1"></i>Login</button>
                <a href="/profile" id="profile-nav-link" class="hover:text-party-accent transition ${currentPage === 'profile' ? 'text-party-accent font-bold' : 'text-gray-300'}" style="display:none"><i class="fas fa-user mr-1"></i><span id="profile-nav-name">Profile</span></a>
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
            if (typeof updateProfileLink === 'function') updateProfileLink();
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
                    <a href="/intro" class="text-gray-400 hover:text-party-accent">Intro</a>
                    <a href="/how-it-works" class="text-gray-400 hover:text-party-accent">How</a>
                    <a href="/whitepaper" class="text-gray-400 hover:text-party-accent">Whitepaper</a>
                    <a href="/laws" class="text-gray-400 hover:text-party-accent">Laws</a>
                    <a href="/generate-law" class="text-gray-400 hover:text-party-accent">Craft a Law</a>
                    <a href="/proposals" class="text-gray-400 hover:text-party-accent">Proposals</a>
                    <a href="/enroll" class="text-gray-400 hover:text-party-accent">Enroll</a>
                    <a href="/wall" class="text-gray-400 hover:text-party-accent">Wall</a>
                    <a href="/events" class="text-gray-400 hover:text-party-accent">Events</a>
                    <a href="/faq" class="text-gray-400 hover:text-party-accent">FAQ</a>
                    <a href="/join" class="text-gray-400 hover:text-party-accent">Join</a>
                    <a href="/donate" class="text-gray-400 hover:text-party-accent">Donate</a>
                    <a href="/treasury" class="text-gray-400 hover:text-party-accent">Treasury</a>
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
    // Find existing nav or create new one
    const existingNav = document.querySelector('nav');
    const newNav = createNavigation();
    
    if (existingNav) {
        existingNav.parentNode.replaceChild(newNav, existingNav);
    } else {
        // Insert at the beginning of body
        document.body.insertBefore(newNav, document.body.firstChild);
    }
    
    // Inject quick login modal
    const modal = createQuickLoginModal();
    document.body.appendChild(modal);
    
    // Inject footer before closing body tag
    const existingFooter = document.querySelector('footer');
    const newFooter = createFooter();
    
    if (existingFooter) {
        existingFooter.parentNode.replaceChild(newFooter, existingFooter);
    } else {
        document.body.appendChild(newFooter);
    }
}

function updateProfileLink() {
    const loginLink = document.getElementById('login-nav-link');
    const profileLink = document.getElementById('profile-nav-link');
    const profileName = document.getElementById('profile-nav-name');
    
    if (loginLink && profileLink) {
        const token = (window.Auth && typeof window.Auth.getToken === 'function') ? window.Auth.getToken() : localStorage.getItem('authToken');
        const isLoggedIn = !!token;
        
        loginLink.style.display = isLoggedIn ? 'none' : 'inline';
        profileLink.style.display = isLoggedIn ? 'inline' : 'none';
        
        if (isLoggedIn && profileName) {
            const user = (window.Auth && typeof window.Auth.getUser === 'function') ? window.Auth.getUser() : null;
            if (user && (user.name || user.username)) {
                profileName.textContent = user.name || user.username;
            }
        }
    }
}

// Verify auth state on page load - call this from any page that needs auth verification
function initAuthOnLoad() {
    if (typeof window.Auth === 'undefined') {
        console.warn('Auth not loaded yet, retrying...');
        setTimeout(initAuthOnLoad, 100);
        return;
    }
    
    const token = window.Auth.getToken();
    if (token) {
        // Verify token is still valid by making a lightweight request
        fetch('/api/user/profile', {
            method: 'HEAD',
            headers: window.Auth.getApiHeaders()
        }).then(res => {
            if (res.status === 401) {
                // Token is invalid, clear it
                window.Auth.clearToken();
                if (typeof updateProfileLink === 'function') updateProfileLink();
            }
        }).catch(() => {
            // Network error, keep token as-is
        });
    }
    
    if (typeof updateProfileLink === 'function') updateProfileLink();
}

// Auto-inject navigation when script loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        injectNavigation();
        updateProfileLink();
    });
} else {
    injectNavigation();
    updateProfileLink();
}

// Listen for auth changes from other tabs/windows
window.addEventListener('storage', (e) => {
    if (e.key === '_3p_auth' || e.key === 'authToken' || e.key === 'user') updateProfileLink();
});

// Visitor tracking
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
