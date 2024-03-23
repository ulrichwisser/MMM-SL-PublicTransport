function Departure(data) {
    this.TransportMode = data.line.transport_mode;
    //this.LineNumber = data.line.designation; // line number as string
    this.LineNumber = data.line.id; // line number as number
    this.Destination = data.destination;
    //this.TimeTabledDateTime = data.TimeTabledDateTime;
    this.ExpectedDateTime = data.expected;
    this.JourneyDirection = data.direction_code;
    this.DisplayTime = data.display;
}

Departure.prototype.ToString = function() {
    return this.TransportMode+ ' ' + this.LineNumber;
}

module.exports = Departure;