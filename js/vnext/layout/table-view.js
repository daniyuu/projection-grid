import _ from 'underscore';
import Backbone from 'backbone';
import ListView from 'backbone-virtualized-listview';

import { HeaderView, FooterView } from './header-footer-view.js';

import rowTemplate from './row.jade';
import tableFixedTemplate from './table-fixed.jade';
import tableStaticTemplate from './table-static.jade';
import tableStickyTemplate from './table-sticky.jade';

import columnGroupTemplate from './column-group.jade';

const STATE_OPTIONS = ['cols', 'headRows', 'bodyRows', 'footRows', 'events'];
const HEADER_TYPES = ['static', 'fixed', 'sticky'];

/**
 * Table view with virtualization support
 * @class TableView
 * @extends Backbone.View
 * @param {Object} options
 *  the constructor options
 * @param {string[]} [options.classes=[]]
 *  the classes for the TABLE elements (content table and sticky/fixed header)
 * @param {ScrollingConfig} [options.scrolling={virtualized: false, header: 'static'}]
 *  the scrolling related configurations
 */
export class TableView extends Backbone.View {
  initialize({ scrolling = {}, classes = [] }) {
    this._props = {
      scrolling: this._normalizeScrollingConfig(scrolling),
      classes,
    };

    this._state = {
      cols: [],
      headRows: [],
      bodyRows: [],
      footRows: [],
      events: {},
    };

    this._listView = new ListView({
      el: this.$el,
      virtualized: this._props.scrolling.virtualized,
      viewport: this._props.scrolling.viewport,
    });

    this._headerView = new HeaderView({ tableView: this });
    this._footerView = new FooterView({ tableView: this });

    _.each(['willRedraw', 'didRedraw'], event => {
      this._listView.on(event, (...args) => {
        this.trigger(event, ...args);
      });
    });
  }

  _normalizeHeaderConfig(config) {
    const header = {};

    if (_.isString(config)) {
      header.type = config;
    } else if (_.isFunction(config) || _.isFinite(config)) {
      header.type = 'sticky';
      header.offset = config;
    } else if (_.isObject(config) && _.isString(config.type)) {
      _.extend(header, _.pick(config, 'type', 'offset'));
    }

    if (!_.contains(HEADER_TYPES, header.type)) {
      header.type = 'static';
    }

    if (header.type === 'sticky' && !_.isFinite(_.result(header, 'offset'))) {
      header.offset = 0;
    }

    return header;
  }

  /**
   * @typedef ScrollingConfig
   * @type {Object}
   *
   * @property {boolean} virtualized
   *  flag for virtualization.
   *
   * @property {(string|HTMLElement|jQuery|window)} viewport
   *  the scrolling viewport. If omit, the table view will auto detect the
   *  closest ancestor of the $el with 'overflowY' style being 'auto' or
   *  'scroll'. Use the window viewport if found none.
   *
   *  NOTE: the viewport takes no effect when using fixed header. Tables with
   *  fixed header render its viewport inside, as the container of the body
   *  and footer.
   *
   * @property {(string|HeaderConfig)} header
   *  the header scrolling behavior configurations. It can be a string to
   *  indicate the header type (`'static'`, `'sticky'` or `'fixed'`). Or an
   *  detailed configuration object.
   *
   */

  /**
   * @typedef HeaderConfig
   * @type {Object}
   * @property {string} type
   * the header type. It can have the following values
   *
   *  * `'static'`: static header, the normal case, the header is rendered to
   *    the top of the grid.
   *  * `'sticky'`: sticky header, the header will stick to the viewport with
   *    a given offset.
   *  * `'fixed'`: fixed header, the header will be outside the viewport. Only
   *    the body and footer are scrollable.
   *
   * @property {number|function} offset
   * special configuration for sticky header indicating its position. It's can
   * be a number or a function returning a number, represents number of pixels
   * below the viewport top.
   */
  _normalizeScrollingConfig({
    viewport,
    virtualized = false,
    header = 'static',
  }) {
    const scrolling = { viewport, virtualized };

    scrolling.header = this._normalizeHeaderConfig(header);

    if (scrolling.header.type === 'fixed') {
      scrolling.viewport = '.viewport';
    }

    return scrolling;
  }

  get headerType() {
    return this._props.scrolling.header.type;
  }

  set(state = {}, callback = _.noop) {
    const isSet = key => !_.isUndefined(state[key]);
    const listState = {};

    _.extend(this._state, _.pick(state, STATE_OPTIONS));

    if (isSet('bodyRows')) {
      const bodyRows = this._state.bodyRows;

      listState.items = {
        length: bodyRows.length,
        slice(start, stop) {
          return _.map(bodyRows.slice(start, stop), row => ({ row }));
        },
      };
    }

    if (isSet('events')) {
      listState.events = state.events;
    }

    this._renderColumnGroup();

    if (this._headerView) {
      this._headerView.redraw();
    }

    if (this._footerView) {
      this._footerView.redraw();
    }

    this._listView.set(listState, callback);

    return this;
  }

  _renderColumnGroup() {
    this.$colgroup = this.$('colgroup.column-group');
    this.$colgroup.html(columnGroupTemplate(this._state));
  }

  _renderHeader() {
    this._headerView.setElement(this.$('thead.header'));
    this._headerView.render();
  }

  _renderFooter() {
    this._footerView.setElement(this.$('tfoot.footer'));
    this._footerView.render();
  }

  /**
   * This is simulating `{ position: sticky }`, but it's still far from perfect.
   *
   * 1. For window viewport
   *    * Use `{ postion: fixed }`
   *    * Adjust the width and the horizontal location on the fly
   *    * Put an dummy filler into the content flow to take the place of header
   *
   * The issues are
   *    * If the subviews in header changes, they have to notify the grid
   *    manually to update the filler's size
   *    * The header doesn't follow the table tightly on horizontal scroll, as
   *    the `scroll` event is triggered after repaint for most browsers
   *
   * 2. For element viewport
   *    * Use `{ position: relative }`
   *    * Adjust the vertical location on the fly
   *
   * The issues are
   *    * The header doesn't follow the table tightly on vertical scroll, as
   *    the `scroll` event is triggered after repaint for most browsers. The
   *    sticky header could be very jumpy on IE and Edge.
   *
   * We wish all browsers support `{ position: sticky }` in a not too far
   * future. So that we can have a perfect solution with native support.
   *
   */
  _hookUpStickyHeader(listView) {
    const viewport = listView.viewport;
    const isWindow = viewport.$el.get(0) === window;
    const $tableContainer = this.$('.table-container');
    const $stickyHeader = this.$('.sticky-header');
    const $stickyHeaderFiller = this.$('.sticky-header-filler');
    const $table = this.$('.sticky-header-filler + table');
    const viewportSize = { width: 0, height: 0 };

    const adjustStickyHeader = () => {
      if (!this.$el.is(':visible')) {
        return;
      }

      const metricsVP = listView.viewport.getMetrics();
      const topVP = metricsVP.outer.top;
      const offset = _.result(this._props.scrolling.header, 'offset', 0);
      const rectContainer =  $tableContainer.get(0).getBoundingClientRect();
      const topCur = rectContainer.top;

      if (isWindow) {
        const sticky = topCur < topVP + offset;
        $stickyHeaderFiller.css({
          display: sticky ? 'block' : 'none',
          height: sticky ? $stickyHeader.height() : '',
        });

        const style = {
          position: sticky ? 'fixed' : 'static',
          top: sticky ? topVP + offset : '',
          left: sticky ? rectContainer.left : '',
        };

        const deltaWidth = Math.abs(metricsVP.outer.width - viewportSize.width);
        const deltaHeight = Math.abs(metricsVP.outer.height - viewportSize.height);
        const resize = deltaWidth >= 1 || deltaHeight >= 1;

        if (resize) {
          // Update the viewportSize
          viewportSize.width = metricsVP.outer.width;
          viewportSize.height = metricsVP.outer.height;

          // Let the content table layout freely, then sync the width to sticky header
          $stickyHeader.css({ width: 'auto' });
          $table.css({ width: 'auto' });
          const width = $tableContainer.width();
          style.width = width;
          $table.css({ width });
        }

        $stickyHeader.css(style);
      } else {
        $stickyHeaderFiller.css({
          display: 'none',
        });
        $stickyHeader.css({
          position: 'relative',
          top: Math.min(Math.max(topVP + offset - topCur, 0), $table.height()),
        });
      }
    };
    listView.viewport.on('resize', () => this.trigger('didChangeBound'));
    listView.viewport.on('scroll', () => this.trigger('didChangeBound'));

    this.on('didChangeBound', adjustStickyHeader);
    listView.on('didRedraw', adjustStickyHeader);
  }

  _renderStatic(callback) {
    this._listView.set({
      model: {
        classes: this._props.classes,
      },
      listTemplate: tableStaticTemplate,
      itemTemplate: rowTemplate,
    }).render(() => {
      this._renderColumnGroup();
      this._renderHeader();
      this._renderFooter();
      callback();
    });
  }

  _renderFixed(callback) {
    this._listView.set({
      model: {
        classes: this._props.classes,
      },
      listTemplate: tableFixedTemplate,
      itemTemplate: rowTemplate,
    }).render(() => {
      this._renderColumnGroup();
      this._renderHeader();
      this._renderFooter();
      callback();
    });

    this._listView.on('didRedraw', () => {
      const widthViewport = this.$('.viewport').get(0).clientWidth;
      const widthContainer = this.el.clientWidth;
      const widthScrollbar = widthContainer - widthViewport;
      const widthTable = this.$('.viewport > table').get(0).offsetWidth;

      this.$el.width(widthTable + widthScrollbar);
      this.$('.fixed-header').width(widthTable);
    });
  }

  _renderSticky(callback) {
    this._listView.set({
      model: {
        classes: this._props.classes,
      },
      listTemplate: tableStickyTemplate,
      itemTemplate: rowTemplate,
    }).render(() => {
      this._renderColumnGroup();
      this._renderHeader();
      this._hookUpStickyHeader(this._listView);
      this._renderFooter();
      callback();
    });
  }

  render(callback = _.noop) {
    const header = this._props.scrolling.header;

    switch (header.type) {
      default:
      case 'static':
        this._renderStatic(callback);
        break;
      case 'fixed':
        this._renderFixed(callback);
        break;
      case 'sticky':
        this._renderSticky(callback);
        break;
    }

    return this;
  }

  remove() {
    if (this._headerView) {
      this._headerView.remove();
    }

    if (this._listView) {
      this._listView.remove();
    }

    if (this._footerView) {
      this._footerView.remove();
    }

    super.remove();
  }

  scrollToItem(...args) {
    this._listView.scrollToItem(...args);
  }

  indexOfElement(el) {
    const $elTr = this._listView.$(el).closest('tr', this._listView.$container);
    if ($elTr.length > 0) {
      return $elTr.index() + this._listView.indexFirst - 1;
    }
    return null;
  }

}
