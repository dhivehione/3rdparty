// Shared navigation component for 3d Party website
// Include this script in all HTML pages

function getPageName() {
    const path = window.location.pathname;
    if (path === '/' || path === '/index.html') return 'home';
    if (path.includes('intro')) return 'intro';
    if (path.includes('how')) return 'how-it-works';
    if (path.includes('whitepaper')) return 'whitepaper';
    if (path.includes('generate-law')) return 'generate-law';
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
                <a href="/generate-law" class="hover:text-party-accent transition ${currentPage === 'generate-law' ? 'text-party-accent font-bold' : 'text-gray-300'}">Generate Law</a>
                <a href="/proposals" class="hover:text-party-accent transition ${currentPage === 'proposals' ? 'text-party-accent font-bold' : 'text-gray-300'}">Proposals</a>
                <a href="/wall" class="hover:text-party-accent transition ${currentPage === 'wall' ? 'text-party-accent font-bold' : 'text-gray-300'}">Wall</a>
                <a href="/events" class="hover:text-party-accent transition ${currentPage === 'events' ? 'text-party-accent font-bold' : 'text-gray-300'}">Events</a>
                <a href="/faq" class="hover:text-party-accent transition ${currentPage === 'faq' ? 'text-party-accent font-bold' : 'text-gray-300'}">FAQ</a>
                <a href="/join" class="px-3 py-1 bg-party-accent text-party-dark rounded font-bold hover:bg-party-accent/80 transition ${currentPage === 'join' ? 'ring-2 ring-party-accent/50' : ''}">Join</a>
                <a href="/donate" class="hover:text-party-accent transition ${currentPage === 'donate' ? 'text-party-accent font-bold' : 'text-gray-300'}">Donate</a>
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
                <div class="flex gap-6 text-sm">
                    <a href="/intro" class="text-gray-400 hover:text-party-accent">Intro</a>
                    <a href="/whitepaper" class="text-gray-400 hover:text-party-accent">Whitepaper</a>
                    <a href="/laws" class="text-gray-400 hover:text-party-accent">Laws</a>
                    <a href="/proposals" class="text-gray-400 hover:text-party-accent">Proposals</a>
                    <a href="/wall" class="text-gray-400 hover:text-party-accent">Wall</a>
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
                © 2024 3d Party Maldives. Built with ❤️ for digital democracy.
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
    
    // Inject footer before closing body tag
    const existingFooter = document.querySelector('footer');
    const newFooter = createFooter();
    
    if (existingFooter) {
        existingFooter.parentNode.replaceChild(newFooter, existingFooter);
    } else {
        document.body.appendChild(newFooter);
    }
}

// Auto-inject navigation when script loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectNavigation);
} else {
    injectNavigation();
}

// Visitor tracking
(function() {
    let sessionId = sessionStorage.getItem('visitor_session');
    if (!sessionId) {
        sessionId = 'v_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        sessionStorage.setItem('visitor_session', sessionId);
    }
    
    // Initialize first-visit timestamp for non-logged-in users
    if (!localStorage.getItem('3dparty_last_login')) {
        localStorage.setItem('3dparty_last_login', new Date().toISOString());
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
