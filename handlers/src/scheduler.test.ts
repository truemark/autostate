import * as cron from 'cron-parser';

test('Test Cron Expressions', () => {
  console.log(new Date());
  let expression = cron.parseExpression('0,10,20,30,40,50 * * * *');
  expect(expression.hasNext()).toBeTruthy();
  let next = expression.next();
  console.log('Moo', next.toISOString());

  expression = cron.parseExpression('0,10,20,30,40,50 * * * *', {
    currentDate: new Date(Date.now() + 60000),
  });
  next = expression.next();
  console.log('Moo', next.toISOString());
  // const interval = cron.parseExpression("0 0 0 * * *");
  // const nextDate = interval.next().toDate();
  // expect(nextDate).toBeInstanceOf(Date);
  // expect(nextDate.toISOString()).toMatch(/T00:00:00\.000Z$/);
});
