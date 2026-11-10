const LOGGING_URL = 'https://europe-west2-kst-chat.cloudfunctions.net/kst-actions';
const ADMIN_URL = window.KST_ADMIN_URL || LOGGING_URL;
let adminChartRows = [];

if (window.google && google.load) {
  google.load('visualization', '1', { packages: ['corechart'] });
}

function _setAdminStatus(message, variant) {
  const el = $('#admin-status');
  if (!el.length) return;
  el.removeClass('alert-secondary alert-success alert-danger alert-warning')
    .addClass(variant || 'alert-secondary')
    .text(message);
}

function _renderAdminStats(users) {
  const body = $('#adminUserStatsBody');
  if (!body.length) return;

  body.empty();
  if (!users || !users.length) {
    body.append('<tr><td colspan="3" class="text-muted">' + I18n.h('admin.noStats') + '</td></tr>');
    return;
  }

  users.forEach(function(user) {
    const lastLogin = user.lastLogin ? new Date(user.lastLogin).toLocaleString() : '—';
    body.append(
      '<tr>' +
        '<td>' + $('<div>').text(user.user || '').html() + '</td>' +
        '<td>' + (user.loginCount || 0) + '</td>' +
        '<td>' + $('<div>').text(lastLogin).html() + '</td>' +
      '</tr>'
    );
  });
}

function _renderRateLimited(rows) {
  const body = $('#adminRateLimitedBody');
  if (!body.length) return;

  body.empty();
  if (!rows || !rows.length) {
    body.append('<tr><td colspan="5" class="text-muted">' + I18n.h('admin.noRateLimited') + '</td></tr>');
    return;
  }

  const esc = function(s) { return $('<div>').text(s == null ? '' : String(s)).html(); };
  rows.forEach(function(row) {
    const lastSeen = row.lastSeen ? new Date(row.lastSeen).toLocaleString() : '—';
    const calls = (row.callsigns || []).join(', ') || '—';
    body.append(
      '<tr>' +
        '<td class="font-monospace small">' + esc(row.client) + '</td>' +
        '<td>' + esc(calls) + '</td>' +
        '<td class="small" title="' + esc(row.userAgent) + '">' + esc((row.userAgent || '').slice(0, 60)) + '</td>' +
        '<td>' + esc(lastSeen) + '</td>' +
        '<td>' + (row.events || 0) + '</td>' +
      '</tr>'
    );
  });
}

function _renderAdminChart(rows) {
  adminChartRows = Array.isArray(rows) ? rows : [];

  const chartDiv = document.getElementById('adminLoginChart');
  if (!chartDiv) return;

  if (!window.google || !google.visualization || !google.visualization.LineChart) {
    chartDiv.innerHTML = '<div class="text-muted small py-5 text-center">' + I18n.h('admin.chartLoading') + '</div>';
    if (window.google && google.setOnLoadCallback) {
      google.setOnLoadCallback(function() {
        _renderAdminChart(adminChartRows);
      });
    }
    return;
  }

  if (!adminChartRows.length) {
    chartDiv.innerHTML = '<div class="text-muted small py-5 text-center">' + I18n.h('admin.noActivity') + '</div>';
    return;
  }

  const data = new google.visualization.DataTable();
  data.addColumn('string', I18n.t('admin.chart.date'));
  data.addColumn('number', I18n.t('admin.chart.logins'));
  data.addColumn('number', I18n.t('admin.chart.uniqueLogins'));

  adminChartRows.forEach(function(row) {
    const label = row.date ? row.date.slice(5) : '';
    data.addRow([label, row.totalLogins || 0, row.uniqueLogins || 0]);
  });

  const chart = new google.visualization.LineChart(chartDiv);
  chart.draw(data, {
    backgroundColor: 'transparent',
    chartArea: { left: 48, top: 24, width: '84%', height: '70%' },
    colors: ['#0d6efd', '#198754'],
    height: 280,
    hAxis: {
      slantedText: true,
      slantedTextAngle: 60,
      textStyle: { color: '#6c757d', fontSize: 10 },
    },
    legend: { position: 'top' },
    lineWidth: 3,
    pointSize: 4,
    vAxis: {
      minValue: 0,
      textStyle: { color: '#6c757d' },
      viewWindow: { min: 0 },
    },
  });
}

function getDetailedStats() {
  if (!userName || !password) {
    _setAdminStatus(I18n.t('admin.noCredentials'), 'alert-warning');
    return;
  }

  _setAdminStatus(I18n.t('admin.loading'), 'alert-secondary');
  $.ajax({
    type: 'POST',
    url: ADMIN_URL,
    contentType: 'application/json',
    dataType: 'json',
    data: JSON.stringify({
      action: 'getDetailedStats',
      data: {
        auth: {
          login: userName,
          password: password
        }
      }
    }),
    success: function(response) {
      if (response.status !== 'OK') {
        _setAdminStatus(response.message || I18n.t('admin.loadFailed'), 'alert-danger');
        _renderAdminStats([]);
        _renderRateLimited([]);
        _renderAdminChart([]);
        return;
      }

      _renderAdminStats(response.data || []);
      _renderRateLimited(response.rateLimited || []);
      _renderAdminChart(response.dailyLogins || []);
      _setAdminStatus(I18n.t('admin.loaded'), 'alert-success');
    },
    error: function(xhr, status, error) {
      _setAdminStatus(I18n.t('admin.loadFailed'), 'alert-danger');
      _renderAdminChart([]);
      console.error('Error:', error, 'Status:', status, 'Response:', xhr.responseText);
    }
  });
}

// Show the Admin tab if kst-actions lists this callsign as an admin. Only the
// callsign is sent; the stats themselves are still password-checked.
function checkAdminAccess() {
  if (!userName) return;
  $.ajax({
    type: 'POST',
    url: ADMIN_URL,
    contentType: 'application/json',
    dataType: 'json',
    data: JSON.stringify({ action: 'checkAdmin', data: { login: userName } }),
    success: function(response) {
      setAdminAccessEnabled(!!(response && response.isAdmin));
    },
    error: function() {
      setAdminAccessEnabled(false);
    }
  });
}

function getStats(){
    $.ajax({
        type: "POST",
        url: LOGGING_URL, 
        contentType: "application/json",
        dataType: "json",
        data: JSON.stringify({
            action: "getStats"
        }),
        success: function(response) {
            $('#userCount').text(response.data.users);
            $('#spotCount').text(response.data.spots);
        },
        error: function(xhr, status, error) {
            console.error("Error:", error, "Status:", status, "Response:", xhr.responseText);
        }
    });
}

// Spots are fetched once per page load, and only after a successful login
// (see procLogin), so idle or reloading pages cost no Firestore reads.
let spotsRequested = false;

function getSpots(){
    if (spotsRequested) return;
    spotsRequested = true;
    $.ajax({
        type: "POST",
        url: LOGGING_URL, 
        contentType: "application/json",
        dataType: "json",
        data: JSON.stringify({
            action: "getSpots"
        }),
        success: function(response) {
            for (let spot of response.data) {
                spot.distance = distLocator(spot.locator, spot.spotter_locator);
                dataTableSpots.row.add(spot);
            }
            dataTableSpots.draw();
        },
        error: function(xhr, status, error) {
            console.error("Error:", error, "Status:", status, "Response:", xhr.responseText);
        }
    });
}

function logSpot(spot){
    spot.date = new Date().toISOString();
    spot.timestamp = Math.floor(Date.now() / 1000);
    $.ajax({
        type: "POST",
        url: LOGGING_URL, 
        data: JSON.stringify({
            action: "logSpot",
            data: spot
        }),  
        contentType: "application/json",
        dataType: "json",
        success: function(response) {
            console.log("Success:", response);
        },
        error: function(xhr, status, error) {
            console.error("Error:", error, "Status:", status, "Response:", xhr.responseText);
        }
    });
}

function logUsage(user) {
  setTimeout(() => {
    fetch(LOGGING_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        action: 'logUser',
        data: user
      })
    })
    .then(response => {
      if (!response.ok) {
        throw new Error('Network response was not ok');
      }
      return response.json();
    })
    .then(data => {
      if (data.stats) {
        $('#userCount').text(data.stats.totalLogins);
        $('#spotCount').text(data.stats.totalSpots);
      }
    })
    .catch(error => {
      console.error('Logging user failed silently:', error);
    });
  }, 0); // fires as soon as call stack is empty

  // 🚀 Main thread continues immediately
}

$(document).on('shown.bs.tab', 'a[href="#tab-admin"]', function() {
    getDetailedStats();
});

$(document).on('click', '#admin-refresh-button', function() {
    getDetailedStats();
});

$(window).on('resize', function() {
  if ($('#tab-admin').hasClass('active')) {
    _renderAdminChart(adminChartRows);
  }
});
