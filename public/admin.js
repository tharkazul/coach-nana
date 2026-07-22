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
        
        let expectedLimit = u.subscription_tier === 'spark_plus' ? 50000 : 10000;
        // Handle legacy DB default where it's 50000
        let dbLimit = u.daily_token_limit;
        if (dbLimit === 50000 && expectedLimit === 10000) dbLimit = 10000;

        const currentLimit = dbLimit || expectedLimit;
        let personalTokenClass = "text-gray-900";
        if (personalTokens >= currentLimit) personalTokenClass = "text-red-600 font-bold";
        else if (personalTokens > currentLimit * 0.8) personalTokenClass = "text-orange-500 font-semibold";

        const tier = u.subscription_tier || 'free';
        const tierSelect = `
            <select onchange="setTier('${u.username}', this.value)" class="text-xs bg-gray-50 border border-gray-200 rounded p-1">
                <option value="free" ${tier === 'free' ? 'selected' : ''}>Free</option>
                <option value="spark_plus" ${tier === 'spark_plus' ? 'selected' : ''}>Spark+</option>
            </select>
        `;

        const clicks = u.spark_plus_clicks || 0;
        const clicksDisplay = clicks > 0 ? `<span class="text-green-600 font-bold">${clicks} <svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg></span>` : '<span class="text-gray-400">0</span>';

        tr.innerHTML = `
            <td class="p-4 font-medium text-gray-900">${u.username}</td>
            <td class="p-4 text-gray-600">${u.login_count || 0}</td>
            <td class="p-4 text-gray-600">${u.chat_count || 0}</td>
            <td class="p-4">${tierSelect}</td>
            <td class="p-4">${clicksDisplay}</td>
            <td class="p-4 ${personalTokenClass}">${personalTokens.toLocaleString()} / ${(currentLimit/1000)}k</td>
            <td class="p-4 text-gray-600">${commonTokens.toLocaleString()}</td>
            <td class="p-4">
                <div class="flex gap-1">${connections.join('') || '<span class="text-gray-400 text-xs italic">None</span>'}</div>
            </td>
            <td class="p-4 text-right space-x-2">
                <button onclick="addTokens('${u.username}')" class="text-xs bg-green-50 text-green-600 hover:bg-green-100 border border-green-200 px-3 py-1 rounded transition">+50k Tokens</button>
                <button onclick="deleteAccount('${u.username}')" class="text-xs bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200 px-3 py-1 rounded transition">Delete Account</button>
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

async function setTier(username, tier) {
    if (!confirm(`Change tier for ${username} to ${tier}?`)) {
        fetchUsage(); // Reset dropdown
        return;
    }

    try {
        const response = await fetch('/api/admin/set-tier', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('nana_token')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ targetUsername: username, tier: tier })
        });

        const data = await response.json();
        if (response.ok) {
            fetchUsage();
        } else {
            showError(data.error || "Failed to set tier.");
        }
    } catch (err) {
        showError("Network error occurred.");
    }
}

async function addTokens(username) {
    if (!confirm(`Are you sure you want to add an extra 50k tokens to the daily limit for ${username}?`)) return;

    try {
        const response = await fetch('/api/admin/add-tokens', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('nana_token')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ targetUsername: username })
        });

        const data = await response.json();
        if (response.ok) {
            fetchUsage();
        } else {
            showError(data.error || "Failed to add tokens.");
        }
    } catch (err) {
        showError("Network error occurred.");
    }
}

async function deleteAccount(username) {
    if (!confirm(`CRITICAL WARNING: Are you absolutely sure you want to PERMANENTLY delete the account for ${username}? This will remove all their activities and data and cannot be undone.`)) return;

    try {
        const response = await fetch(`/api/admin/delete-user/${encodeURIComponent(username)}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('nana_token')}`
            }
        });

        const data = await response.json();
        if (response.ok) {
            fetchUsage(); // Refresh the table
        } else {
            showError(data.error || "Failed to delete account.");
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
