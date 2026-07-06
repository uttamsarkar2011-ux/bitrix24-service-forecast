const https = require('https');

const BITRIX_WEBHOOK = 'https://allcad-bitrix.bitrix24.com/rest/11/rl0nc1et56j5v9rk/';
const CATEGORY_ID = '47';

// Custom field codes
const F = {
  REG_NUM:     'UF_CRM_1783318769827',
  SVC_DATE:    'UF_CRM_1783318790990',
  ODOMETER:    'UF_CRM_1783318817698',
  PREV_DATE:   'UF_CRM_1783318834601',
  PREV_ODO:    'UF_CRM_1783318851535',
  AVG_DAILY:   'UF_CRM_1783318872621',
  PROJ_DATE:   'UF_CRM_1783318902895',
  NEXT_SVC:    'UF_CRM_1783318917880',
  ONE_YEAR:    'UF_CRM_1783318939435',
  DAYS_KM_DIFF:'UF_CRM_1783318970603'
};

function bitrixCall(method, params) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(params);
    const url = new URL(BITRIX_WEBHOOK + method);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + Math.round(days));
  return d.toISOString().split('T')[0];
}

function addYears(dateStr, years) {
  const d = new Date(dateStr);
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().split('T')[0];
}

function daysBetween(d1, d2) {
  const ms = new Date(d2) - new Date(d1);
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

exports.handler = async (event) => {
  try {
    let dealId = null;

    // Handle both GET and POST
    if (event.httpMethod === 'POST') {
      const body = event.body ? JSON.parse(event.body) : {};
      dealId = body.deal_id || body.DEAL_ID || (body.data && body.data.FIELDS && body.data.FIELDS.ID);
    } else {
      dealId = event.queryStringParameters && event.queryStringParameters.deal_id;
    }

    if (!dealId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'deal_id required' }) };
    }

    // Step 1: Get current deal
    const dealResp = await bitrixCall('crm.deal.get', { id: dealId });
    const deal = dealResp.result;
    if (!deal) return { statusCode: 404, body: JSON.stringify({ error: 'Deal not found' }) };

    const regNum = deal[F.REG_NUM];
    const currentSvcDate = deal[F.SVC_DATE];
    const currentOdo = parseFloat(deal[F.ODOMETER] || 0);

    if (!regNum || !currentSvcDate || !currentOdo) {
      return { statusCode: 200, body: JSON.stringify({ message: 'Missing required fields: RegNum, ServiceDate or Odometer' }) };
    }

    // Step 2: Find previous service deal for same vehicle
    const listResp = await bitrixCall('crm.deal.list', {
      filter: {
        'CATEGORY_ID': CATEGORY_ID,
        [F.REG_NUM]: regNum
      },
      select: ['ID', F.SVC_DATE, F.ODOMETER],
      order: { 'ID': 'DESC' },
      start: 0
    });

    const allDeals = listResp.result || [];
    // Exclude current deal, find latest previous with valid service date & odometer
    const prevDeal = allDeals.find(d =>
      String(d.ID) !== String(dealId) &&
      d[F.SVC_DATE] &&
      parseFloat(d[F.ODOMETER] || 0) > 0
    );

    let prevDate = deal[F.PREV_DATE];
    let prevOdo = parseFloat(deal[F.PREV_ODO] || 0);

    if (prevDeal) {
      prevDate = prevDeal[F.SVC_DATE];
      prevOdo = parseFloat(prevDeal[F.ODOMETER] || 0);
    }

    if (!prevDate || !prevOdo) {
      return { statusCode: 200, body: JSON.stringify({ message: 'No previous service record found. Please fill Previous Service Date and Previous Odometer manually.' }) };
    }

    // Step 3: Calculate
    const kmDiff = currentOdo - prevOdo;
    const dayDiff = daysBetween(prevDate, currentSvcDate);
    const avgDaily = dayDiff > 0 ? kmDiff / dayDiff : 0;
    const daysFor10000 = avgDaily > 0 ? Math.round(10000 / avgDaily) : 365;
    const projectedDate = addDays(currentSvcDate, daysFor10000);
    const oneYearDate = addYears(currentSvcDate, 1);
    const nextSvcDate = projectedDate < oneYearDate ? projectedDate : oneYearDate;

    // Step 4: Update current deal fields
    const updateFields = {
      [F.PREV_DATE]:    prevDate,
      [F.PREV_ODO]:     String(prevOdo),
      [F.AVG_DAILY]:    String(Math.round(avgDaily * 100) / 100),
      [F.DAYS_KM_DIFF]: String(Math.round(kmDiff)),
      [F.PROJ_DATE]:    projectedDate,
      [F.ONE_YEAR]:     oneYearDate,
      [F.NEXT_SVC]:     nextSvcDate
    };

    await bitrixCall('crm.deal.update', { id: dealId, fields: updateFields });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        deal_id: dealId,
        reg_num: regNum,
        avg_daily_km: Math.round(avgDaily * 100) / 100,
        projected_date: projectedDate,
        one_year_date: oneYearDate,
        next_service_date: nextSvcDate
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
