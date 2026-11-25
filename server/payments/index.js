export const paymentProviders = {
  cash_on_delivery: {
    createPayment({ amountPiasters }) {
      return { method: 'cash_on_delivery', state: 'pay_on_delivery', amountPiasters };
    },
  },
};

// Future gateway adapters use this contract without changing checkout or order storage.
export function createPayment(method, details) {
  const provider = paymentProviders[method];
  if (!provider) throw Object.assign(new Error('Payment method is unavailable.'), { status: 400 });
  return provider.createPayment(details);
}
