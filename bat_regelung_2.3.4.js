/*
MIT License - see LICENSE.md 
Copyright (c) [2020] [Matthias Boettger <mboe78@gmail.com>]
*/
/*Version 2.3.4 2022/02/04*/
// Debug
var debug = 1; /*debug ausgabe ein oder aus 1/0 */

// statische Parameter
var update = 5, /*Update interval in sek, 15 ist ein guter Wert*/
    pvpeak = 6600, /*pv anlagenleistung Wp */
    batcap = 5120, /*netto batterie kapazität in Wh, statisch wegen fehlerhafter Berechnung im SI*/
    surlimit = 90, /*pv einspeise limit in % */
    bat_grenze = 10, /*nutzbare mindestladung der Batterie, nicht absolutwert sondern zzgl unterer entladegrenze des Systems! z.b. 50% Entladetiefe + 10% -> bat_grenze = 10*/
    bat_ziel = 100, /*gewünschtes Ladeziel der Regelung, bei Blei ca 85% da dann die Ladeleistung stark abfällt und keine vernünftige Regelung mehr zulässt. Bei LI sollte es 100 sein.*/
    grundlast = 100, /*Grundlast in Watt falls bekannt*/
    wr_eff = 0.9, /* Bat + WR Effizienz z.b. Li-Ion 0,9 (90%), PB 0,8 (80%), oder auch halbe Roundtrip-Effizienz*/
    bat_wr_pwr = 0, /* Ladeleistung der Batterie in W, 0=automatik (wird ausgelesen)*/
    ModBusBat = "modbus.0", /*ID der Modbusinstanz im ioBroker für den BatterieWR*/
    vis = "0_userdata.0.",
    SMA_EM = "sma-em.0.3013343860", /*Name der SMA EnergyMeter/HM2 Instanz bei installierten SAM-EM Adapter, leer lassen wenn nicht vorhanden*/
    Javascript = "javascript.0",
    Verbraucher = []; /*starke Verbraucher mit Power in W berücksichtigen, hier kann der Realverbrauch in einem externen Script berechnet werden*/

// BAT-WR Register Definition, nur bei Bedarf anpassen
var BatChaMaxW = ModBusBat + ".holdingRegisters.40795_CmpBMS_BatChaMaxW",/*Maximale Batterieladeleistung*/
    BatDsChaMaxW = ModBusBat + ".holdingRegisters.40799_CmpBMS_BatDschMaxW",/*Maximale Batterieentladeleistung*/
    FedInSpntCom = ModBusBat + ".holdingRegisters.40151_Inverter_WModCfg_WCtlComCfg_WCtlComAct", /*Wirk- und Blindleistungsregelung über Kommunikation*/
    FedInPwrAtCom = ModBusBat + ".holdingRegisters.40149_Inverter_WModCfg_WCtlComCfg_WSpt", /*Wirkleistungsvorgabe*/
    BatChaMaxWvis = vis + "40795_CmpBMS_BatChaMaxW",/*Maximale Batterieladeleistung*/
    BatDsChaMaxWvis = vis + "40799_CmpBMS_BatDschMaxW",/*Maximale Batterieentladeleistung*/
    FedInSpntComvis = vis + "40151_Inverter_WModCfg_WCtlComCfg_WCtlComAct", /*Wirk- und Blindleistungsregelung über Kommunikation*/
    FedInPwrAtComvis = vis + "40149_Inverter_WModCfg_WCtlComCfg_WSpt", /*Wirkleistungsvorgabe*/
    BAT_SoC = ModBusBat + ".inputRegisters.30845_Bat_ChaStt", /*selbserklärend ;) */
    SelfCsmpDmLim = 10, /*unteres Entladelimit Eigenverbrauchsbereich (Saisonbetrieb)*/
    PowerOut = SMA_EM + ".psurplus", /*aktuelle Einspeiseleistung am Netzanschlußpunkt, BatWR*/
    WMaxCha = 5000, /*max Ladeleistung BatWR*/
    WMaxDsch = 5000, /*max Entladeleistung BatWR*/
    BatType = 1785, /*Abfrage Batterietyp*/
    PowerAC = ModBusBat + ".inputRegisters.30775_GridMs_TotW", /*Power AC*/
    Dev_Type = 19049, /*Typnummer*/
    bms_def = 2424,
    SpntCom_def = 803,
    lastSpntCom = 0,
    lastmaxchrg = 0,
    lastmaxdischrg = 0
      
// ab hier Programmcode, nichts ändern!
function processing() {
// Start der Parametrierung
  var DevType = Dev_Type
  if (DevType < 9356 || DevType > 9362) {
    var batlimit = SelfCsmpDmLim
  }
  if (batlimit < 0 || batlimit > 100){
    console.log("Warnung! Ausgelesenes Entladelimit unplausibel! Setze auf 0%")
    batlimit = 0
  }
  var batsoc = Math.min(getState(BAT_SoC).val,100),     //batsoc = Batterieladestand
      cur_power_out = getState(PowerOut).val,           //cur_power_out = Einspeisung an SHM
      batminlimit = batlimit+bat_grenze,                //batminlimit = 20
      batwr_pwr = bat_wr_pwr                            //batwr_pwr = 0 --> Automatik
      if (bat_wr_pwr == 0){
        batwr_pwr = WMaxCha                             //batwr_pwr = 5000
      }
  var maxchrg_def = batwr_pwr,                          //maxchrg_def = batwr_pwr = 5000
      maxdischrg_def = WMaxDsch,                        //maxdischrg_def = 5000
      PwrAtCom_def = batwr_pwr*(253/230),               //max power bei 253V: 5000*(253/230)=5500
      bat = BatType,                                    //bat = 1785
      power_ac = getState(PowerAC).val*-1,              //power_ac = -(Einspeisung an SHM)
      pvlimit = (pvpeak / 100 * surlimit),              //pvlimit = 6600/100*0,9 = 5940
      pwr_verbrauch = 0,
      /* Default Werte setzen*/
      RmgChaTm = 0,
      bms = bms_def,                                    //bms = 2424
      minchrg = 0,
      maxchrg = maxchrg_def,                            //maxchrg = maxchrg_def = batwr_pwr = 5000
      mindischrg = 0,
      maxdischrg = maxdischrg_def,                      //maxdischrg = maxdischrg_def = 5000
      GridWSpt = 0,
      SpntCom = SpntCom_def,                            //SpntCom = 803
      PwrAtCom = PwrAtCom_def,                          //PwrArCom = 5500
      awattar_active = 0;
  for (let v = 0; v < Verbraucher.length ; v++) {
    pwr_verbrauch = pwr_verbrauch + getState(Verbraucher[v]).val
  }
  if (debug == 1){console.log("Verbraucher:" + pwr_verbrauch.toFixed(0) + "W")}
    
//Parametrierung Speicher
  // Lademenge
  var ChaEnrg_full = Math.ceil((batcap * (100 - batsoc) / 100)*(1/wr_eff))              //Energiemenge bis vollständige Ladung
  var ChaEnrg = ChaEnrg_full
  ChaEnrg = Math.max(Math.ceil((batcap * (bat_ziel - batsoc) / 100)*(1/wr_eff)), 0);    //ChaEnrg = Energiemenge bis vollständige Ladung
  var ChaTm = ChaEnrg/batwr_pwr;                                                        //Ladezeit = Energiemenge bis vollständige Ladung / Ladeleistung WR

  if ( bat == 1785 && ChaTm <= 0 ) {                    //Wenn Batterietyp = 1785 && Ladezeit <= 0
    ChaTm = ChaEnrg_full/batwr_pwr                      //Ladezeit = Energiemenge bis vollständige Ladung / Ladeleistung WR
    ChaEnrg = ChaEnrg_full
  }
// Ende der Parametrierung
  if (debug == 1){console.log("Lademenge " + ChaEnrg + "Wh")}
  if (debug == 1){console.log("Restladezeit " + ChaTm.toFixed(2) + "h")}

// Start der PV Prognose Sektion
  var latesttime
  var pvfc = []
  var f = 0
  /*Liest die PV-Prognose für die nächsten 24 Stunden ein */
  for (let p = 0; p < 48 ; p++) { /* 48 = 24h a 30min Fenster*/
    var pvpower50 = getState(Javascript + ".electricity.pvforecast."+ p + ".power").val,
        pvpower90 = getState(Javascript + ".electricity.pvforecast."+ p + ".power90").val,
        pvendtime = getState(Javascript + ".electricity.pvforecast."+ p + ".endTime").val,
        pvstarttime = getState(Javascript + ".electricity.pvforecast."+ p + ".startTime").val,
        grundlast_calc = grundlast
    if (compareTime(pvstarttime, pvendtime, "between")){
      grundlast_calc = pwr_verbrauch
    }
    if ( pvpower90 > (pvlimit+grundlast_calc) ){
      if (compareTime(pvendtime, null, "<=", null)) {
        var minutes = 30
        if (pvpower50 < pvlimit){
          var minutes = Math.round((100-(((pvlimit-pvpower50)/((pvpower90-pvpower50)/40))+50))*18/60)
        }  
        pvfc[f] = [pvpower50, pvpower90, minutes, pvstarttime, pvendtime];
        f++;
      }
    };
  };
  if (pvfc.length > 0){latesttime = pvfc[(pvfc.length-1)][4]}
    pvfc.sort(function(b, a){
            return a[1] - b[1];
  });
  if (debug == 1 && pvfc.length > 0){console.log(pvfc)}
  if (debug == 1 && latesttime){console.log("Abschluss bis " + latesttime)}
  var max_pwr = batwr_pwr;

  // verschieben des Ladevorgangs in den Bereich der PV Limitierung.
  if ( ChaTm > 0 && (ChaTm*2) <= pvfc.length && batsoc >= batminlimit) {
    // Bugfix zur behebung der array interval von 30min und update interval 1h
    if ((compareTime(latesttime, null, "<=", null)) && awattar_active == 0) {
      maxchrg = 0;
    }
    //berechnung zur entzerrung entlang der pv kurve, oberhalb des einspeiselimits
    var get_wh = 0;
    for (let k = 0; k < pvfc.length; k++) {
      var pvpower = pvfc[k][0]
      if (pvpower < (pvlimit+grundlast_calc)){
        pvpower = pvfc[k][1]
      }
      minutes = pvfc[k][2]
      if (compareTime(pvfc[k][3], pvfc[k][4], "between")){
        //rechne restzeit aus
        var now = new Date();
        var options = { hour12: false, hour: '2-digit', minute:'2-digit'}
        var nowTime = now.toLocaleTimeString('de-DE', options)
        var startsplit = nowTime.split(":")
        var endsplit = pvfc[k][4].split(":")
        var minutescalc = (Number(endsplit[0])*60 + Number(endsplit[1]))-(Number(startsplit[0])*60 + Number(startsplit[1]))
        if (minutescalc < minutes){
          minutes = minutescalc
        }
      }
      get_wh = get_wh + (((pvpower/2)-((pvlimit+grundlast_calc)/2))*(minutes/30)) // wieviele Wh Überschuss???
    }
    if (debug == 1){console.log("Überschuß " + Math.round(get_wh) + "Wh")}
    var pvlimit_calc = pvlimit,
        min_pwr = 0
    //Scenario 4
    if (ChaEnrg > get_wh && ChaEnrg > 0 && ChaTm > 0){
      if ((ChaTm*2) <= pvfc.length){
        ChaTm = pvfc.length/2 //entzerren des Ladevorganges
      }
      if (awattar_active == 0){
        pvlimit_calc = Math.max((Math.round(pvlimit - ((ChaEnrg - get_wh)/ChaTm))),0) //virtuelles reduzieren des pvlimits
        min_pwr = Math.max(Math.round((ChaEnrg - get_wh)/ChaTm),0)
      }
      get_wh = ChaEnrg // sprungpunkt in Scenario 5 
      if (debug == 1){console.log("Verschiebe Einspeiselimit auf " + pvlimit_calc + "W" + " mit mindestens " + min_pwr + "W")}
    }
    
    //Scenario 5
    if (get_wh >= ChaEnrg && ChaEnrg > 0){
      ChaTm = pvfc.length/2      
      var current_pwr_diff = 100-pvlimit_calc+cur_power_out //bleibe 100W unter dem Limit (PV-WR Trigger)

      if (awattar_active == 0){
        max_pwr = Math.round(power_ac+current_pwr_diff)
        if ( power_ac <= 0 && current_pwr_diff < 0 ){
          max_pwr = 0
        }
      }
      //aus der begrenzung holen...
      if (power_ac <= 10 && current_pwr_diff > 0 ){ 
        max_pwr = Math.round(pvfc[0][1]-pvlimit_calc)
        if (current_pwr_diff > max_pwr){
          max_pwr = Math.round(current_pwr_diff)
        }
      }
    }

    max_pwr = Math.round(Math.min(Math.max(max_pwr, min_pwr), batwr_pwr)) //abfangen negativer werte, limitiere auf min_pwr
    //berechnung Ende

    for (let h = 0; h < (ChaTm*2); h++) {
      if ((compareTime(pvfc[h][3], pvfc[h][4], "between")) || (cur_power_out + power_ac) >= (pvlimit-100)){ 
        maxchrg = max_pwr;
      }; 
    };
  };
// Ende der PV Prognose Sektion

//write data
if (maxchrg != maxchrg_def || maxchrg != lastmaxchrg || maxdischrg != maxdischrg_def || maxdischrg != lastmaxdischrg) {
  if (debug == 1){console.log("Daten an WR:" + maxchrg + ', '+ maxdischrg)}
  setState(BatChaMaxW, maxchrg, false);
  setState(BatDsChaMaxW, maxdischrg, false);
  setState(BatChaMaxWvis, maxchrg, false);
  setState(BatDsChaMaxWvis, maxdischrg, false);
}
lastmaxchrg = maxchrg
lastmaxdischrg = maxdischrg

//if (debug == 1){console.log(SpntCom + "!=" + SpntCom_def + "||" + SpntCom + "!=" + lastSpntCom)}
if (SpntCom != SpntCom_def || SpntCom != lastSpntCom) {
  if (debug == 1){console.log("Daten an WR:" + SpntCom + ', ' + PwrAtCom)}
  setState(FedInSpntCom, SpntCom, false);
  setState(FedInPwrAtCom, PwrAtCom, false);
  setState(FedInSpntComvis, SpntCom, false);
  setState(FedInPwrAtComvis, PwrAtCom, false);
}
lastSpntCom = SpntCom

}

var Interval = setInterval(function () {
  processing(); /*start processing in interval*/
}, (update*1000));
