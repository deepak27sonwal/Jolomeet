// Shared confirmation and report dialogs, built on native <dialog>.
// The markup is created on first use, so pages don't need to include it.
import { icon, setLoading, friendlyError } from './ui.js';

let confirmDialog;
let reportDialog;

/** Asks a yes/no question. Resolves true only if the person confirms. */
export function confirmAction({ title, message, confirmLabel }) {
  confirmDialog ??= createConfirmDialog();
  confirmDialog.querySelector('[data-title]').textContent = title;
  confirmDialog.querySelector('[data-message]').textContent = message;
  confirmDialog.querySelector('[data-confirm="yes"]').textContent = confirmLabel;
  return new Promise((resolve) => {
    confirmDialog.returnValue = '';
    confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'yes'), { once: true });
    confirmDialog.showModal();
    confirmDialog.querySelector('[data-confirm="no"]').focus();
  });
}

/**
 * Opens the report form. `onSubmit({ reason, details, alsoBlock })` performs the
 * report; the dialog stays open and shows the error if it throws.
 */
export function openReportDialog({ name, onSubmit }) {
  reportDialog ??= createReportDialog();
  const form = reportDialog.querySelector('form');
  form.reset();
  reportDialog.querySelector('[data-title]').textContent = `Report ${name}`;
  setError('');
  reportDialog.querySelector('.alert').hidden = true;

  form.onsubmit = async (event) => {
    event.preventDefault();
    const reason = form.elements.reason;
    if (!reason.value) {
      setError('Choose a reason.');
      reason.focus();
      return;
    }
    setError('');
    const button = form.querySelector('[type="submit"]');
    setLoading(button, true);
    try {
      await onSubmit({
        reason: reason.value,
        details: form.elements.details.value.trim(),
        alsoBlock: form.elements.alsoBlock.checked,
      });
      reportDialog.close();
    } catch (error) {
      const alert = reportDialog.querySelector('.alert');
      alert.className = 'alert alert--error';
      alert.innerHTML = icon('alert');
      alert.append(document.createTextNode(friendlyError(error)));
      alert.hidden = false;
    } finally {
      setLoading(button, false);
    }
  };
  reportDialog.showModal();
}

function setError(message) {
  const select = reportDialog.querySelector('[name="reason"]');
  const el = reportDialog.querySelector('[data-reason-error]');
  select.setAttribute('aria-invalid', String(Boolean(message)));
  el.innerHTML = message ? icon('alert') : '';
  if (message) el.append(document.createTextNode(message));
}

function createConfirmDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal modal--sm';
  dialog.setAttribute('aria-labelledby', 'confirm-title');
  dialog.setAttribute('aria-describedby', 'confirm-message');
  dialog.innerHTML = `
    <header class="modal__header"><h2 id="confirm-title" data-title></h2></header>
    <div class="modal__body"><p id="confirm-message" class="text-muted" data-message></p></div>
    <footer class="modal__footer">
      <button class="btn btn--secondary" type="button" data-confirm="no">Cancel</button>
      <button class="btn btn--danger" type="button" data-confirm="yes"></button>
    </footer>`;
  dialog.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-confirm]');
    if (choice) dialog.close(choice.dataset.confirm);
  });
  document.body.append(dialog);
  return dialog;
}

function createReportDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal modal--sm';
  dialog.setAttribute('aria-labelledby', 'report-title');
  dialog.innerHTML = `
    <form novalidate>
      <header class="modal__header">
        <h2 id="report-title" data-title>Report</h2>
        <button class="icon-button" type="button" data-close aria-label="Close">${icon('close')}</button>
      </header>
      <div class="modal__body">
        <p class="text-muted">Reports are confidential. Our moderators review every one.</p>
        <div class="alert" role="alert" hidden></div>
        <div class="field">
          <label class="field__label" for="report-reason">Reason</label>
          <select class="input input--plain" id="report-reason" name="reason" required aria-describedby="report-reason-error">
            <option value="">Choose a reason</option>
            <option value="spam">Spam or scam</option>
            <option value="harassment">Harassment or bullying</option>
            <option value="hate">Hate speech</option>
            <option value="nudity">Nudity or sexual content</option>
            <option value="violence">Violence or threats</option>
            <option value="underage">Appears to be under 18</option>
            <option value="impersonation">Pretending to be someone else</option>
            <option value="other">Something else</option>
          </select>
          <p class="field__error" id="report-reason-error" data-reason-error></p>
        </div>
        <div class="field">
          <label class="field__label" for="report-details">Details <span class="text-muted">(optional)</span></label>
          <textarea class="input input--plain" id="report-details" name="details" maxlength="1000" rows="3" placeholder="What happened?"></textarea>
        </div>
        <label class="checkbox"><input type="checkbox" name="alsoBlock" checked> <span>Also block this person</span></label>
      </div>
      <footer class="modal__footer">
        <button class="btn btn--secondary" type="button" data-close>Cancel</button>
        <button class="btn btn--danger" type="submit">Submit Report</button>
      </footer>
    </form>`;
  dialog.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => dialog.close()));
  document.body.append(dialog);
  return dialog;
}
