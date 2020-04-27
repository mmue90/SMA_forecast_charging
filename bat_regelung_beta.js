/*
MIT License - see LICENSE.md 
Copyright (c) [2020] [Matthias Boettger <mboe78@gmail.com>]
*/

// statische Parameter
var Interval,
    batcap = 25344, /*Batterie Kapazität in Wh*/
    pvpeak = 12090, /*pv anlagenleistung Wp */
    surlimit = 33, /*pv einspeise limit in % */
    bat_grenze = 15, /*nutzbare mindestladung der Batterie, nicht absolutwert sondern zzgl unterer entladegrenze des Systems! z.b. 50% Entladetiefe + 10% Mindestladung = 10*/
    batwr_pwr = 4600, /*Ladeleistung des BatterieWR*/
    lossfact = 1.1, /*Ladeverlust Factor 1.1 = 10% Ladeverlust*/
    pb_bat = 1; /*Speicher ist Blei (=1)/Lithium(=0), Blei Speicher laden nicht bis 100% im normalen Ladezyklus. Die Ladekurve flacht ab 85% extrem ab, daher wird nur bis 85% berechnet zur optimalen Energieausnutzung*/

// BAT-WR Register
var CmpBMSOpMod = "modbus.2.holdingRegisters.40236_CmpBMSOpMod",/*Betriebsart des BMS*/
    BatChaMaxW = "modbus.2.holdingRegisters.40795_BatChaMaxW",/*Maximale Batterieladeleistung*/
    BatDsChaMaxW = "modbus.2.holdingRegisters.40799_BatDschMaxW",/*Maximale Batterieentladeleistung*/
    FedInSpntCom = "modbus.2.holdingRegisters.40151_FedInSpntCom", /*Wirk- und Blindleistungsregelung über Kommunikation*/
    FedInPwrAtCom = "modbus.2.holdingRegisters.40149_FedInPwrAtCom", /*Wirkleistungsvorgabe*/
    BAT_SoC = "modbus.2.inputRegisters.30845_BAT_SoC", /*selbserklärend ;) */
    SelfCsmpDmLim = "modbus.2.inputRegisters.31009_SelfCsmpDmLim", /*unteres Entladelimit Eigenverbrauchsbereich (Saisonbetrieb)*/
    RemainChrgTime = "modbus.2.inputRegisters.31007_RmgChaTm", /*verbleibende Restladezeit für Boost Ladung (nur PB Speicher?)*/
    PowerOut = "modbus.2.inputRegisters.30867_TotWOut", /*aktuelle Einspeiseleistung am Netzanschlußpunkt
    /*BMS Default des BatWR (SI6.0H-11), andere WR ggf anpassen*/
    bms_def = 2424,
    maxchrg_def = 5100,
    maxdischrg_def = 5100,
    SpntCom_def = 803,
    PwrAtCom_def = 5100;

// ab hier Awattar Bereich
var awattar = 1, /*wird Awattar benutzt (dyn. Strompreis) 0=nein, 1=ja*/
    gridprice = 16.992 /*(netto bezugspreis)*/,
    taxprice = gridprice * 0.19, /*Deutscher Sonderweg, Eigenverbrauch wird mit Steuer aus entgangenen Strombezug besteuert.*/
    pvprice = 12.31,  /*pv preis*/
    start_charge = pvprice + taxprice, /*Eigenverbrauchspreis*/
    vis = 1, /*visualisierung nutzen?*/
    Metering_WhIn = "modbus.2.inputRegisters.30595_Metering_WhIn", /*WR Wh geladen*/
    Metering_WhOut = "modbus.2.inputRegisters.30597_Metering_WhOut"; /*WR Wh entladen*/
// Ende Awattar

// ab hier Programmcode, nichts ändern!
function processing() {
// Start der Parametrierung
  var batsoc = getState(BAT_SoC).val,
      batlimit = getState(SelfCsmpDmLim).val,
      RmgChaTm = getState(RemainChrgTime).val/3600,
      cur_power_out = getState(PowerOut).val,
      batminlimit = batlimit+bat_grenze,
      ChaEnrg = Math.ceil((batcap * (100 - batsoc) / 100)*lossfact),
      pvlimit = (pvpeak / 100 * surlimit),
      /* Default Werte setzen*/
      bms = bms_def, 
      maxchrg = maxchrg_def,
      maxdischrg = maxdischrg_def,
      SpntCom = SpntCom_def,
      PwrAtCom = PwrAtCom_def;
//nur für Awattar
  if (awattar == 1) {
    var startTime0 = getState("javascript.0.electricity.prices.0.startTime").val,
        endTime0 = getState("javascript.0.electricity.prices.0.endTime").val,
        price0 = getState("javascript.0.electricity.prices.0.price").val,
        inwh = getState(Metering_WhIn).val,
        outwh = getState(Metering_WhOut).val,
        loadfact = 1-(outwh/inwh)+1,
        stop_discharge = start_charge * loadfact;
  };  
//Parametrierung Bleispeicher
  if (pb_bat == 1) {
    ChaEnrg = Math.ceil((batcap * (85 - batsoc) / 100)*lossfact);
  }
  if (ChaEnrg < 0) {
    ChaEnrg = 0
  }
  var ChaTm = ChaEnrg/batwr_pwr;
  if ( ChaTm == 0 ) {
    ChaTm = RmgChaTm
  }
  //PB float situation "Erhaltungsladung"
  if ( batsoc >= 85 && RmgChaTm == 0 ) {
    ChaTm = 0;
  }
  
// Ende der Parametrierung
  console.log(ChaEnrg + "Wh")
  console.log(ChaTm.toFixed(1) + "h");  

// Start der Awattar Sektion
  if (awattar == 1){
    let poi = [];
      for (let t = 0; t < 12 ; t++) {
        poi[t] = [getState("javascript.0.electricity.prices."+ t + ".price").val, getState("javascript.0.electricity.prices."+ t + ".startTime").val, getState("javascript.0.electricity.prices."+ t + ".endTime").val];
    };
  
    poi.sort(function(a, b, c){
      return a[0] - b[0];
    });
  
    let lowprice = []; //wieviele Ladestunden unter Startcharge Preis
    for (let x = 0; x < Math.ceil(ChaTm); x++) {
      if (poi[x][0] < start_charge){
        lowprice[x] = [poi[x][0]];
      }
    };
    //console.log(lowprice.length)

    if (compareTime(startTime0, endTime0, "between"))  {
      if (price0) {
        if (price0 < stop_discharge && batsoc <= batminlimit) {
          bms = 2290;
          maxdischrg = 0;
        }
        if (batsoc >= batlimit && ChaTm != 0 && Math.ceil(ChaTm) <= lowprice.length) {     
          for (let a = 0; a < poi.length; a++) {
            if (poi[a][0] < start_charge){
              bms = 2289;
              maxchrg = 0;
            };
          };
        };      
        if (price0 < start_charge) {
          bms = 2289;
          maxchrg = 0;
          maxdischrg = 0;
          SpntCom = 802;
          PwrAtCom = 0;
          if (batsoc <= batlimit) {
            bms = 2289;
            maxchrg = 100;
            maxdischrg = 0;
            SpntCom = 802;
            PwrAtCom = -100;
          }

          for (let i = 0; i < Math.ceil(ChaTm); i++) {
            if (compareTime(poi[i][1], poi[i][2], "between")){
              bms = 2289;
              maxchrg = maxchrg_def;
              maxdischrg = 0;
              SpntCom = 802;
              PwrAtCom = PwrAtCom_def*-1;
            };
          };
        };
      };
    };
  };
// Ende der Awattar Sektion

// Start der PV Prognose Sektion
  let pvfc = [];
  let f = 0;
    for (let p = 0; p < 24 ; p++) { /* 24 = 12h a 30min Fenster*/
        var pvpower = getState("javascript.0.electricity.pvforecast."+ p + ".power").val;
        if ( pvpower >= pvlimit){
            var pvendtime = getState("javascript.0.electricity.pvforecast."+ p + ".startTime").val,
                pvstarttime = formatDate(getDateObject((getDateObject(pvendtime).getTime() - 1800000)), "SS:mm");
            pvfc[f] = [pvpower, pvstarttime, pvendtime];
            f++;
        };
    };
  //console.log(pvfc);
  
  pvfc.sort(function(b, a){
            return a[0] - b[0];
  });

  var ChaTm_old = ChaTm;
  var max_pwr = batwr_pwr;
  // verschieben des Ladevorgangs in den Bereich der PV Limitierung.
  if ( ChaTm > 0 && (ChaTm*2) <= pvfc.length && batsoc >= batminlimit ) {
    bms = 2289;
    maxchrg = 0;
    // *Neu* Entzerrung des Ladevorgangs auf die Dauer der Anlagenbegrenzung
    ChaTm = pvfc.length/2;
    max_pwr = Math.round(batwr_pwr*ChaTm_old/ChaTm);
    //berechnung zur entzerrung entlang der pv kurve, oberhalb des einspeiselimits
    var get_wh = 0;
    for (let k = 0; k < pvfc.length; k++) {
      get_wh = get_wh + ((pvfc[k][0]/2)-(pvlimit/2)) // wieviele Wh Überschuss???
    }
    if (get_wh > ChaEnrg && ChaEnrg > 0){
      max_pwr = Math.min(Math.round(pvfc[0][0]-pvlimit+(cur_power_out-pvlimit)), 0) /*berücksichtigung der reellen Einspeiseleistung, statt default wert.*/
    }
    //berechnung Ende
    console.log(get_wh)

    for (let h = 0; h < (ChaTm*2); h++) {
      console.log(pvfc[h][1] + ', ' + pvfc[h][2] + ', ' + pvfc[h][0])
      if (compareTime(pvfc[h][1], pvfc[h][2], "between")){ 
        bms = 2289;
        maxchrg = max_pwr;
        maxdischrg = maxdischrg_def,
        SpntCom = SpntCom_def,
        PwrAtCom = PwrAtCom_def;
      }; 
    };
  };
// Ende der PV Prognose Sektion

//write data
console.log(bms + ', ' + maxchrg + ', ' + maxdischrg + ', ' + SpntCom + ', ' + PwrAtCom)
setState(CmpBMSOpMod, bms);
setState(BatChaMaxW, maxchrg);
setState(BatDsChaMaxW, maxdischrg);
setState(FedInSpntCom, SpntCom);
setState(FedInPwrAtCom, PwrAtCom);
if (awattar == 1 && vis == 1){
  setState("javascript.0.electricity.prices.batprice",stop_discharge); /*dient nur für Visualisierung*/
  setState("javascript.0.electricity.prices.PVprice", start_charge); /*dient nur für Visualisierung*/
};
};

Interval = setInterval(function () {
  processing(); /*start processing in interval*/
}, 60000);