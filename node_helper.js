/* node_helper.js
 *
 * Magic Mirror module - Display public transport in Stockholm/Sweden. 
 * This module use the API's provided by Trafiklab.
 * 
 * Magic Mirror
 * Module: MMM-SL-PublicTransport
 * 
 * Magic Mirror By Michael Teeuw http://michaelteeuw.nl
 * MIT Licensed.
 * 
 * Module MMM-SL-PublicTransport By Anders Boghammar
 */
const NodeHelper = require("node_helper");
const request = require("request-promise");
var HttpsProxyAgent = require('https-proxy-agent');
var Url = require('url');
var Departure = require('./departure.js');
var debugMe = false;

module.exports = NodeHelper.create({

    // --------------------------------------- Start the helper
    start: function () {
        //Log.info('Starting helper: '+ this.name);
        log('Starting helper: ' + this.name);
        this.started = false;
    },

    // --------------------------------------- Schedule a departure update
    scheduleUpdate: function () {
        var self = this;
        debug('scheduleUpdate=' + self.getNextUpdateInterval());
        this.updatetimer = setInterval(function () { // This timer is saved in uitimer so that we can cancel it
            self.getDepartures();
        }, self.getNextUpdateInterval());
    },

    // --------------------------------------- Retrive departure info
    getDepartures: function () {
        var self = this;

        clearInterval(this.updatetimer); // Clear the timer so that we can set it again

        //debug("stationid is array="+Array.isArray(this.config.stationid));
        var Proms = [];
        // Loop over all stations
        if (this.config.stations !== undefined) {
            this.config.stations.forEach(station => {
                var P = new Promise((resolve, reject) => {
                    self.getDeparture(station, resolve, reject);
                });
                debug('Pushing promise for station ' + station.stationId);
                console.log(P);
                Proms.push(P);
            });

            Promise.all(Proms).then(CurrentDeparturesArray => {
                debug('all promises resolved '+CurrentDeparturesArray);
                self.sendSocketNotification('DEPARTURES', CurrentDeparturesArray); // Send departures to module
            }).catch(reason => {
                debug('One or more promises rejected '+reason);
                self.sendSocketNotification('SERVICE_FAILURE', reason);
            });
        } else {
            debug('Stations not defined ');
            self.sendSocketNotification('SERVICE_FAILURE', { resp: { Message: 'config.stations is not defined', StatusCode: 500}});
        }

        self.scheduleUpdate(); // reinitiate the timer
    },

    // --------------------------------------- Get departures for one station
    // The CurrentDepartures object holds this data
    //  CurrentDepartures = {
    //      StationId: string
    //      LatestUpdate: date,     // When the realtime data was updated
    //      DataAge: ??,            // The age of the data in ??
    //      departures: [dir][deps] // An array of array of Departure objects
    //  }
    getDeparture: function(station, resolve, reject) {
        log('Getting departures for station id ' + station.stationId);
        var self = this;

        // Use Trafiklab API SL Transport
        // e.g. curl -X 'GET' 'https://transport.integration.sl.se/v1/sites/2322/departures?forecast=60&direction=2' -H 'accept: application/json' -H 'Content-Type: application/json'
        uri = 'https://transport.integration.sl.se/v1/sites/' + station.stationId + '/departures?forecast=' + station.forecast;
        if (station.direction !== undefined) {
            uri = uri + '&direction='+station.direction;
        }
        var opt = {
            uri: uri,
            headers: {
                'Content-Type' : 'application/json',
                'accept' : 'application/json'
            },
            json: true,
            resolveWithFullResponse: true
        };


        if (this.config.proxy !== undefined) {
            opt.agent = new HttpsProxyAgent(Url.parse(this.config.proxy));
            debug('SL-PublicTransport: Using proxy ' + this.config.proxy);
        }
        debug('SL-PublicTransport: station id ' + station.stationId + ' Calling ' + opt.uri);
        request(opt)
            .then(function (resp) {
                if (resp.statusCode == 200) {

                    // build array of departures by direction
                    var departures = [];
                    self.addDepartures(station, departures, resp.body.departures);

                    // build our answer object
                    var CurrentDepartures = {};
                    CurrentDepartures.StationId = station.stationId;
                    CurrentDepartures.StationName = (station.stationName === undefined ? 'NotSet' : station.stationName);
                    CurrentDepartures.obtained = new Date(); // When we got it.
                    CurrentDepartures.LatestUpdate = new Date(); // New API doesn't really give us that data, so we use now
                    CurrentDepartures.departures = [];

                    // Add departures
                    for (var ix = 0; ix < departures.length; ix++) {
                        if (departures[ix] !== undefined) {
                            for (var iy = 0; iy < departures[ix].length; iy++) {
                                CurrentDepartures.departures.push(departures[ix][iy]);
                            }
                        }
                    }

                    // TODO:Handle resp.ResponseData.StopPointDeviations

                    // Done
                    log('Found ' + CurrentDepartures.departures.length + ' DEPARTURES for station id=' + station.stationId);
                    resolve(CurrentDepartures);
                } else {
                    log('Something went wrong: station id=' + station.stationId + ' StatusCode: ' + resp.statusCode + ' Msg: ' + resp.statusMessage);
                    reject(resp);
                }
            })
            .catch(function (err) {
                log('Problems: station id=' + station.stationId + ' ' + err);
                reject( { resp: { StatusCode: 600, Message: err } });
            });
    },

    // --------------------------------------- Add departures to our departures array
    addDepartures: function (station, departures, depArray) {
        for (var ix = 0; ix < depArray.length; ix++) {
            var element = depArray[ix];
            console.log(element);
            var dep = new Departure(element);
            console.log('New dep');
            console.log(dep);
            //debug("BLine: " + dep.LineNumber);
            dep = this.fixJourneyDirection(station, dep); 
            if (this.isWantedLine(station, dep)) {
                if (this.isWantedDirection(dep.JourneyDirection)) { // TODO not needed, remove
                    debug("Adding Line: " + dep.LineNumber + " Dir:" + dep.JourneyDirection + " Dst:" + dep.Destination);
                    if (departures[dep.JourneyDirection] === undefined) {
                        departures[dep.JourneyDirection] = [];
                    }
                    departures[dep.JourneyDirection].push(dep);
                }
            }
        }
    },

    // --------------------------------------- Are we asking for this direction
    isWantedDirection: function (dir) {
        if (this.config.direction !== undefined && this.config.direction != '') {
            return dir == this.config.direction;
        }
        return true;
    },

    // --------------------------------------- If we want to change direction number on a line
    fixJourneyDirection: function (station, dep) {
        var swapper = [0, 2, 1];
        if (station.lines !== undefined && Array.isArray(station.lines)) {
            for (var il=0; il < station.lines.length; il++) { // Check if this is a line we have defined
                if (dep.LineNumber == station.lines[il].line) {
                    debug("Checking direction for line "+ dep.LineNumber + " Dir: " + dep.JourneyDirection);
                    if (station.lines[il].swapDir !== undefined && station.lines[il].swapDir) {
                        var newdir = swapper[dep.JourneyDirection];
                        debug("Swapping direction for line "+ dep.LineNumber + " From: " + dep.JourneyDirection + " To: " + newdir);
                        dep.JourneyDirection = newdir;
                    }
                }
            }
        }
        return dep;
    },

    // --------------------------------------- Are we asking for this line in this direction
    isWantedLine: function (station, dep) {
        //debug('0 ')
        if (station.lines !== undefined) {
            console.log(station);
            if (Array.isArray(station.lines)) {
                for (var il=0; il < station.lines.length; il++) { // Check if this is a line we want
                    l1 = (typeof(dep.LineNumber) === 'string' ? dep.LineNumber.toUpperCase() : dep.LineNumber);
                    l2 = (typeof(station.lines[il].line) === 'string' ? station.lines[il].line.toUpperCase() : station.lines[il].line);
                    debug("Lines "+ dep.LineNumber + " checked against "+ station.lines[il].line);
                    if (l1 == l2) {
                        debug("Checking line "+ dep.LineNumber + " Dir: " + dep.JourneyDirection)
                        if (station.lines[il].direction !== undefined) {
                            if (dep.JourneyDirection == station.lines[il].direction) {
                                return true;
                            } else {
                                return false;
                            }
                        } else {
                            return true; // We take all directions for this line
                        }
                    }
                }
                return false;
            } else {
                log('Problems: station id=' + station.stationId + ' lines is defined but not as array.');
                throw new Error('station id=' + station.stationId + ' lines is defined but not as array.')
            }
        } else {
            return true; // Take all lines on this station
        }
    },

    // --------------------------------------- Get the line number of a lines entry
    getLineNumber: function (ix) {
        var wasarray = false;
        var ll = this.config.lines[ix];
        if (Array.isArray(ll)) { //ll !== null && typeof ll === 'array') {
            ll = ll[0];
            wasarray = true;
        }
        //debug("IX: "+ ix + " LL:" + ll + " wasarray " + wasarray);                            
        return ll;
    },

    // --------------------------------------- Figure out the next update time
    getNextUpdateInterval: function() {
        if (this.config.highUpdateInterval === undefined) return this.config.updateInterval;
        // TODO: dont throw here use the normal update time but log the errors
        if (this.config.highUpdateInterval.times === undefined) {
            log("ERROR: highUpdateInterval.times is undefined in configuration.");
            log("ERROR: Please remove the highUpdateInterval parameter if you do not use it.");
            return this.config.updateInterval;
        }
        if (!Array.isArray(this.config.highUpdateInterval.times)) throw new Error("highUpdateInterval.times is not an array")
        
        //Check which interval we are in and return the proper timer
        for (let i = 0; i < this.config.highUpdateInterval.times.length; i++) {
            const intervalDefinition = this.config.highUpdateInterval.times[i];
            if (this.isBetween(intervalDefinition.days, intervalDefinition.start, intervalDefinition.stop)) {
                if (intervalDefinition.updateInterval !== undefined) {
                    // If the interval has it's own update frequency defined, use that
                    return intervalDefinition.updateInterval
                }
                // If the interval doesn't have it own update frequency defined, use the high interval frequency.
                return this.config.highUpdateInterval.updateInterval
            }
        }
        return this.config.updateInterval;
    },
    
    // --------------------------------------- Check if now is in this time
    isBetween: function (days, start, stop) {
        var now = new Date();
        var dow = now.getDay();
        switch (days) {
            case 'weekdays':
                if (0 < dow && dow < 6) {
                    return this.isTimeBetween(start, stop);
                }
            break;
            case 'weekends':
                if (0 == dow || dow == 6) {
                    return this.isTimeBetween(start, stop);
                }
            break;
        }
        return false;
    },
    
    // --------------------------------------- Check if now is between these times
    isTimeBetween: function (start, stop) {
        var now = new Date();
        var st = dateObj(start);
        var en = dateObj(stop);
        if (st > en) {      // check if start comes before end
            var temp = st;  // if so, assume it's across midnight
            st = en;        // and swap the dates
            en = temp;
        }
        
        return now < en && now >st 
    },
        
    // --------------------------------------- Handle notifocations
    socketNotificationReceived: function (notification, payload) {
        const self = this;
        if (notification === 'CONFIG' /*&& this.started == false*/) {
            this.config = payload;
            this.started = true;
            debugMe = this.config.debug;
            self.scheduleUpdate();
            self.getDepartures(); // Get it first time
        };
    }
});

//
// Utilities
//
function dynamicSort(property) {
    var sortOrder = 1;
    if (property[0] === "-") {
        sortOrder = -1;
        property = property.substr(1);
    }
    return function (a, b) {
        var result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0;
        return result * sortOrder;
    }
}

// --------------------------------------- Create a date object with the time in timeStr (hh:mm)
function dateObj(timeStr) {
    var parts = timeStr.split(':');
    var date  = new Date();
    date.setHours(+parts.shift());
    date.setMinutes(+parts.shift());
    return date;
}

// --------------------------------------- At beginning of log entries
function logStart() {
    return (new Date(Date.now())).toLocaleTimeString() + " MMM-SL-PublicTransport: ";
}

// --------------------------------------- Logging
function log(msg) {
    console.log(logStart() + msg);
}
// --------------------------------------- Debugging
function debug(msg) {
    if (debugMe) log(msg);
}
