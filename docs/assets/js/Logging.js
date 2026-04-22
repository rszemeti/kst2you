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
    body.append('<tr><td colspan="3" class="text-muted">No admin stats available.</td></tr>');
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

function _renderAdminChart(rows) {
  adminChartRows = Array.isArray(rows) ? rows : [];

  const chartDiv = document.getElementById('adminLoginChart');
  if (!chartDiv) return;

  if (!window.google || !google.visualization || !google.visualization.LineChart) {
    chartDiv.innerHTML = '<div class="text-muted small py-5 text-center">Login chart is loading…</div>';
    if (window.google && google.setOnLoadCallback) {
      google.setOnLoadCallback(function() {
        _renderAdminChart(adminChartRows);
      });
    }
    return;
  }

  if (!adminChartRows.length) {
    chartDiv.innerHTML = '<div class="text-muted small py-5 text-center">No login activity available for the selected period.</div>';
    return;
  }

  const data = new google.visualization.DataTable();
  data.addColumn('string', 'Date');
  data.addColumn('number', 'Logins');
  data.addColumn('number', 'Unique logins');

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
    _setAdminStatus('Login credentials are not available for admin stats.', 'alert-warning');
    return;
  }

  _setAdminStatus('Loading admin stats…', 'alert-secondary');
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
        _setAdminStatus(response.message || 'Failed to load admin stats.', 'alert-danger');
        _renderAdminStats([]);
        _renderAdminChart([]);
        return;
      }

      _renderAdminStats(response.data || []);
      _renderAdminChart(response.dailyLogins || []);
      _setAdminStatus('Admin stats loaded.', 'alert-success');
    },
    error: function(xhr, status, error) {
      _setAdminStatus('Failed to load admin stats.', 'alert-danger');
      _renderAdminChart([]);
      console.error('Error:', error, 'Status:', status, 'Response:', xhr.responseText);
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

function getSpots(){
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
