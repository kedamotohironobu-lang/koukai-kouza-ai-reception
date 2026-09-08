(function(global){
  'use strict';
  function build(config, data) {
    const recipient=String(config.receptionEmail||'').trim();
    if(!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(recipient))throw new Error('確認メールの送信先が未設定または不正です');
    const single=v=>String(v??'').replace(/[\r\n]+/g,' ').trim();
    for(const key of ['receiptNumber','affiliation','name','phone','display','title','method'])if(!single(data[key]))throw new Error('確認メールに必要な情報が不足しています');
    const subject=`【公開講座受付確認】${single(data.receiptNumber)}`;
    const body=[
      '公開講座ご担当者様','',
      '以下の内容で公開講座の受講を申し込みます。','',
      `受付番号：${single(data.receiptNumber)}`,
      `所属：${single(data.affiliation)}`,
      `氏名：${single(data.name)}`,
      `所属電話番号：${single(data.phone)}`,
      `希望講座：${single(data.display)} ${single(data.title)}`,
      `受講方法：${single(data.method)}`,'',
      'よろしくお願いいたします。'
    ].join('\r\n');
    return {recipient,subject,body,
      preview:`送信先：${recipient}\n件名：${subject}\n\n${body}`,
      mailto:`mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
      testMode:recipient!==String(config.productionEmail||'').trim()};
  }
  global.ConfirmationEmail={build};
})(typeof window!=='undefined'?window:globalThis);
