class ADIFRecord {
  constructor() {
    this.data = [];
        
    const currentDate = new Date();
    // Format the date as YYYYMMDD (e.g., 20231019 for October 19, 2023)
    const formattedDate = currentDate.toISOString().slice(0, 10).replace(/-/g, ''); // Remove hyphens

    const formattedTime = currentDate.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false, // Use 24-hour format
    }).replace(/:/g, ''); // Remove colons

    this.addField('qso_date', formattedDate);
    this.addField('time_on', formattedTime);
  }

  addField(fieldName, fieldValue) {
      this.data.push(`<${fieldName}:${fieldValue.length}>${fieldValue}`);
  }

  // Get the ADIF data string
  getADIF() {
    // Join all the fields with the <eor> tag and return as a single string
    return this.data.join('') + '<eor>';
  }
}

// Usage example:
class QRZ {
   static apiUrl = 'https://logbook.qrz.com/api';

    constructor(callsign){
       this.key = localStorage.getItem('qrz_key'); 
    }
    
    setKey(key){
        this.key=key;
        localStorage.setItem('qrz_key',key); 
    }

  logContact(rec) {
    const adifData = rec.getADIF();

    const formData = new FormData();
    formData.append('KEY', this.key);
    formData.append('ACTION', 'INSERT');
    formData.append('ADIF', adifData);

    // Send the POST request to the API
    fetch(this.apiUrl, {
      method: 'POST',
      body: formData,
    })
      .then((response) => response.text())
      .then((data) => {
        // Parse the response
        const responseLines = data.split('&');
        const responseObj = {};
        for (const line of responseLines) {
          const [key, value] = line.split('=');
          responseObj[key] = value;
        }

        // Check the result
        if (responseObj.RESULT === 'OK') {
          console.log('Insert successful');
          console.log('Log ID:', responseObj.LOGIDS);
          console.log('Count:', responseObj.COUNT);
        } else {
          console.error('Insert failed');
        }
      })
      .catch((error) => {
        console.error('Error:', error);
      });
  }
}


const adifRecord = new ADIFRecord();

adifRecord.addField('band', '80m');
adifRecord.addField('mode', 'SSB');
adifRecord.addField('call', 'XX1X');
adifRecord.addField('station_callsign', 'AA7BQ');


console.log(adifRecord.getADIF());

