// I test controllano anche messaggi in italiano: la lingua non deve dipendere dal sistema
// (sul runner di GitHub Actions sarebbe inglese).
import { setLang } from '../src/i18n';

setLang('it');
