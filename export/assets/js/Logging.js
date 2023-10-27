const SPOT_URL = 'https://europe-west2-kst-chat.cloudfunctions.net/kst-spots';

const USE_URL = 'https://europe-west2-kst-chat.cloudfunctions.net/kst-usage';

const STATS_URL = 'https://europe-west2-kst-chat.cloudfunctions.net/kst-stats';

function getStats(){
    $.ajax({
        type: "GET",
        url: STATS_URL, 
        contentType: "application/json",
        dataType: "json",
        success: function(response) {
            $('#userCount').text(response.kstUsageCount);
            $('#spotCount').text(response.kstSpotsCount);
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
        url: SPOT_URL,
        data: JSON.stringify(spot),  
        contentType: "application/json",
        dataType: "json",
        success: function(response) {
            //console.log("Success:", response);
        },
        error: function(xhr, status, error) {
            console.error("Error:", error, "Status:", status, "Response:", xhr.responseText);
        }
    });
}

function logUsage(user){
    user.date = new Date().toISOString();
    user.timestamp = Math.floor(Date.now() / 1000);
    $.ajax({
        type: "POST",
        url: USE_URL,
        data: JSON.stringify(user),  
        contentType: "application/json",
        dataType: "json",
        success: function(response) {
            //console.log("Success:", response);
        },
        error: function(xhr, status, error) {
            console.error("Error:", error, "Status:", status, "Response:", xhr.responseText);
        }
    });
}