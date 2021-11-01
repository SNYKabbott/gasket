import Enzyme from 'enzyme';
// TODO: switch to official adapter once available:
//  https://github.com/enzymejs/enzyme/pull/2430
import Adapter from '@wojtekmaj/enzyme-adapter-react-17';

// React 16 Enzyme adapter
Enzyme.configure({ adapter: new Adapter() });
