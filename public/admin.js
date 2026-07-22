async function fetchUsage() {
    try {
        const response = await fetch('/api/admin/usage', {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('nana_token')}`
            }
        });

        if (!response.ok) {
            if (response.status === 403 || response.status === 401) {
                window.location.href = '/';
                return;
            }
            throw new Error(`Failed to fetch: ${response.status}`);
        }

        const users = await response.json();
        renderTable(users);
        updateStats(users);
    } catch (err) {
        showError("Could not load user data. Are you an admin?");
        console.error(err);
    }
}

function renderTable(users) {
    const tbody = document.getElementById('userTableBody');
    tbody.innerHTML = '';

    if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-gray-500">No users found.</td></tr>';
        return;
    }

    users.forEach(u => {
        const tr = document.createElement('tr');
        tr.className = "hover:bg-gray-50 transition";
        
        const connections = [];
        if (u.strava_connected) connections.push('<span class="bg-orange-100 text-orange-800 text-xs px-2 py-1 rounded font-medium">Strava</span>');
        if (u.garmin_connected) connections.push('<span class="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded font-medium">Garmin</span>');
        
        const personalTokens = u.daily_token_usage || 0;
        const commonTokens = u.common_token_usage || 0;
        
        let personalTokenClass = "text-gray-900";
        if (personalTokens > 40000) personalTokenClass = "text-red-600 font-bold";
        else if (personalTokens > 25000) personalTokenClass = "text-orange-500 font-semibold";

        tr.innerHTML = `
            <td class="p-4 font-medium text-gray-900">${u.username}</td>
            <td class="p-4 text-gray-600">${u.login_count || 0}</td>
            <td class="p-4 text-gray-600">${u.chat_count || 0}</td>
            <td class="p-4 ${personalTokenClass}">${personalTokens.toLocaleString()} / 50k</td>
            <td class="p-4 text-gray-600">${commonTokens.toLocaleString()}</td>
            <td class="p-4">
                <div class="flex gap-1">${connections.join('') || '<span class="text-gray-400 text-xs italic">None</span>'}</div>
            </td>
            <td class="p-4 text-right space-x-2">
                <button onclick="resetTokens('${u.username}')" class="text-xs bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 px-3 py-1 rounded transition">Reset Tokens</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function updateStats(users) {
    document.getElementById('statTotalUsers').innerText = users.length;
    
    const totalPersonal = users.reduce((sum, u) => sum + (u.daily_token_usage || 0), 0);
    const totalCommon = users.reduce((sum, u) => sum + (u.common_token_usage || 0), 0);
    
    document.getElementById('statPersonalTokens').innerText = totalPersonal.toLocaleString();
    document.getElementById('statCommonTokens').innerText = totalCommon.toLocaleString();
}

async function resetTokens(username) {
    if (!confirm(`Are you sure you want to reset all token usage for ${username}?`)) return;

    try {
        const response = await fetch('/api/admin/reset-tokens', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('nana_token')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ targetUsername: username })
        });

        const data = await response.json();
        if (response.ok) {
            fetchUsage(); // Refresh the table
        } else {
            showError(data.error || "Failed to reset tokens.");
        }
    } catch (err) {
        showError("Network error occurred.");
    }
}

function showError(msg) {
    const toast = document.getElementById('errorToast');
    document.getElementById('errorMsg').innerText = msg;
    toast.classList.remove('opacity-0');
    toast.classList.remove('pointer-events-none');
    
    setTimeout(() => {
        toast.classList.add('opacity-0');
        toast.classList.add('pointer-events-none');
    }, 4000);
}

// Init
document.addEventListener('DOMContentLoaded', fetchUsage);
