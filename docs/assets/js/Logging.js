const LOGGING_URL = 'https://europe-west2-kst-chat.cloudfunctions.net/kst-actions';

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
